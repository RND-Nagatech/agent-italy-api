import { ForbiddenException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { AgentDataSourceConfig } from '../sources/source.types';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { validSalesMatch } from './sales-query-policy';
import { SalesReportBranch, SalesReportJenis, SalesReportQuery, SalesReportResult } from './sales-report.types';

interface SalesReportDataSource {
  databaseName: string;
  alias: string;
  branchId: string;
}

interface SalesReportAggregate {
  totals: Array<{
    invoiceCount: number;
    detailCount: number;
    soldWeight: number;
    salesAmount: number;
    rowsWithoutWeight: number;
  }>;
  jenis: Array<{
    _id: string;
    invoiceCount: number;
    detailCount: number;
    soldWeight: number;
    salesAmount: number;
    rowsWithoutWeight: number;
  }>;
  jenisCount: Array<{ count: number }>;
}

interface DepartmentNameRow {
  kode_dept: string;
  nama_dept?: string;
}

const MAX_CONCURRENT_BRANCH_QUERIES = 4;
const MAX_ACTIVE_BRANCH_SOURCES = 100;
const MAX_JENIS_PER_BRANCH = 100;
const MAX_QUERY_TIME_MS = 30_000;
const RESERVED_DATABASES = new Set(['admin', 'local', 'config']);

@Injectable()
export class SalesReportService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  async report(
    query: SalesReportQuery,
    principal: AuthPrincipal,
    refresh = false,
  ): Promise<SalesReportResult> {
    const range = validateDateRange(query.from, query.to);
    const branchId = cleanOptional(query.branchId);
    const jenisCode = cleanOptional(query.jenisCode);
    const branchScope = principal.role === Role.Branch ? principal.branchId?.trim() ?? '' : null;
    if (principal.role === Role.Branch && !branchScope) {
      throw new ForbiddenException('Branch account has no branch scope');
    }
    if (branchScope && branchId && branchScope !== branchId) {
      throw new ForbiddenException('Akun cabang hanya dapat membaca laporan penjualannya sendiri.');
    }

    const sourceFilter: Document = {
      active: true,
      databaseName: { $nin: [...RESERVED_DATABASES, env.systemDatabaseName] },
    };
    if (branchScope) {
      sourceFilter.branchId = branchScope;
      sourceFilter.sourceType = { $ne: 'central' };
    }
    else if (branchId) sourceFilter.branchId = branchId;

    const sources = await this.mongo.db.collection<AgentDataSourceConfig>('shipment_sources')
      .find(sourceFilter, { projection: { _id: 0, databaseName: 1, alias: 1, branchId: 1 } })
      .sort({ branchId: 1, alias: 1 })
      .limit(MAX_ACTIVE_BRANCH_SOURCES)
      .toArray() as SalesReportDataSource[];

    if (!sources.length) {
      if (branchScope) throw new ForbiddenException('No active data source configured for this branch');
      throw new SalesReportError('Tidak ada sumber toko aktif yang cocok dengan filter laporan.');
    }

    const key = `agent:sales-period-report:v2:${JSON.stringify({
      from: range.from,
      to: range.to,
      branchScope,
      branchId: branchId ?? null,
      jenisCode: jenisCode ?? null,
      sources: sources.map(({ databaseName, alias, branchId: id }) => ({ databaseName, alias, branchId: id })),
    })}`;
    if (refresh) this.cache.clearByPrefix('agent:sales-period-report:v2:');

    return this.cache.getOrLoad(key, () => this.loadReport(sources, range, jenisCode));
  }

  private async loadReport(
    sources: SalesReportDataSource[],
    range: { from: string; to: string; daysInclusive: number },
    jenisCode?: string,
  ): Promise<SalesReportResult> {
    const branches = await mapWithConcurrency(sources, MAX_CONCURRENT_BRANCH_QUERIES, async (source) => {
      try {
        return await this.aggregateBranch(source, range, jenisCode);
      } catch {
        return unavailableBranch(source);
      }
    });
    branches.sort((left, right) => {
      if (left.status !== right.status) return left.status === 'available' ? -1 : 1;
      return right.soldWeight - left.soldWeight || left.alias.localeCompare(right.alias);
    });
    const available = branches.filter((branch) => branch.status === 'available');
    const unavailableSources = branches
      .filter((branch) => branch.status === 'unavailable')
      .map(({ branchId, alias, unavailableReason }) => ({ branchId, alias, reason: unavailableReason ?? 'Query gagal atau melewati batas waktu.' }));

    return {
      mode: 'sales-period-report',
      period: { from: range.from, to: range.to, field: 'tgl_system', daysInclusive: range.daysInclusive },
      weightUnit: 'gram',
      policy: {
        salesFilter: 'status_kembali=OPEN, status_valid=DONE, status_tukar!=true, trs_barang_tukar!=true',
        weight: 'Jumlah field berat per baris transaksi, dalam gram',
      },
      summary: {
        branchesRequested: sources.length,
        branchesAnalyzed: available.length,
        branchesUnavailable: unavailableSources.length,
        invoiceCount: sum(available, (branch) => branch.invoiceCount),
        detailCount: sum(available, (branch) => branch.detailCount),
        soldWeight: round3(sum(available, (branch) => branch.soldWeight)),
        salesAmount: roundMoney(sum(available, (branch) => branch.salesAmount)),
        rowsWithoutWeight: sum(available, (branch) => branch.rowsWithoutWeight),
      },
      branches,
      unavailableSources,
    };
  }

  private async aggregateBranch(
    source: SalesReportDataSource,
    range: { from: string; to: string; daysInclusive: number },
    jenisCode?: string,
  ): Promise<SalesReportBranch> {
    const match: Document = {
      ...validSalesMatch(),
      tgl_system: { $gte: range.from, $lte: range.to },
    };
    if (jenisCode) match.kode_dept = jenisCode;

    const pipeline: Document[] = [
      { $match: match },
      {
        $project: {
          jenis: { $ifNull: ['$kode_dept', '__TANPA_JENIS__'] },
          invoice: '$no_faktur_jual',
          weight: toDouble('$berat'),
          amount: toDouble('$harga_total'),
        },
      },
      {
        $facet: {
          totals: [
            { $group: { _id: '$invoice', detailCount: { $sum: 1 }, soldWeight: { $sum: '$weight' }, salesAmount: { $sum: '$amount' }, rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } } } },
            {
              $group: {
                _id: null,
                invoiceCount: { $sum: { $cond: [{ $and: [{ $eq: [{ $type: '$_id' }, 'string'] }, { $ne: ['$_id', ''] }] }, 1, 0] } },
                detailCount: { $sum: '$detailCount' },
                soldWeight: { $sum: '$soldWeight' },
                salesAmount: { $sum: '$salesAmount' },
                rowsWithoutWeight: { $sum: '$rowsWithoutWeight' },
              },
            },
          ],
          jenis: [
            { $group: { _id: { jenis: '$jenis', invoice: '$invoice' }, detailCount: { $sum: 1 }, soldWeight: { $sum: '$weight' }, salesAmount: { $sum: '$amount' }, rowsWithoutWeight: { $sum: { $cond: [{ $gt: ['$weight', 0] }, 0, 1] } } } },
            {
              $group: {
                _id: '$_id.jenis',
                invoiceCount: { $sum: { $cond: [{ $and: [{ $eq: [{ $type: '$_id.invoice' }, 'string'] }, { $ne: ['$_id.invoice', ''] }] }, 1, 0] } },
                detailCount: { $sum: '$detailCount' },
                soldWeight: { $sum: '$soldWeight' },
                salesAmount: { $sum: '$salesAmount' },
                rowsWithoutWeight: { $sum: '$rowsWithoutWeight' },
              },
            },
            { $sort: { soldWeight: -1, _id: 1 } },
            { $limit: MAX_JENIS_PER_BRANCH },
          ],
          jenisCount: [{ $group: { _id: '$jenis' } }, { $count: 'count' }],
        },
      },
    ];

    const db = this.mongo.getDatabase(source.databaseName);
    const [aggregate] = await db.collection('tt_jual_detail')
      .aggregate<SalesReportAggregate>(pipeline, { allowDiskUse: true, maxTimeMS: MAX_QUERY_TIME_MS })
      .toArray();
    const summary = aggregate?.totals?.[0];
    const rawJenis = aggregate?.jenis ?? [];
    const codes = rawJenis.map(({ _id }) => _id).filter((code) => code !== '__TANPA_JENIS__');
    const departments = codes.length
      ? await db.collection<DepartmentNameRow>('tm_dept')
        .find({ kode_dept: { $in: codes } }, { projection: { _id: 0, kode_dept: 1, nama_dept: 1 } })
        .toArray()
      : [];
    const names = new Map(departments.map((department) => [department.kode_dept, decryptDepartmentName(department.nama_dept) ?? department.kode_dept]));
    const soldWeight = finiteNumber(summary?.soldWeight);
    const jenis: SalesReportJenis[] = rawJenis.map((row) => ({
      code: row._id,
      name: row._id === '__TANPA_JENIS__' ? 'Jenis tidak tercatat' : names.get(row._id) ?? row._id,
      invoiceCount: positive(row.invoiceCount),
      detailCount: positive(row.detailCount),
      soldWeight: round3(finiteNumber(row.soldWeight)),
      salesAmount: roundMoney(finiteNumber(row.salesAmount)),
      rowsWithoutWeight: positive(row.rowsWithoutWeight),
      sharePercent: soldWeight > 0 ? roundPercent(positive(row.soldWeight) / soldWeight * 100) : 0,
    }));

    return {
      branchId: source.branchId,
      alias: source.alias,
      status: 'available',
      invoiceCount: positive(summary?.invoiceCount),
      detailCount: positive(summary?.detailCount),
      soldWeight: round3(soldWeight),
      salesAmount: roundMoney(finiteNumber(summary?.salesAmount)),
      rowsWithoutWeight: positive(summary?.rowsWithoutWeight),
      jenis,
      omittedJenisCount: Math.max(0, positive(aggregate?.jenisCount?.[0]?.count) - jenis.length),
    };
  }
}

export class SalesReportError extends Error {}

function validateDateRange(fromValue: unknown, toValue: unknown): { from: string; to: string; daysInclusive: number } {
  const from = parseDate(fromValue);
  const to = parseDate(toValue);
  if (from > to) throw new SalesReportError('Tanggal awal harus sama atau sebelum tanggal akhir.');
  const daysInclusive = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (daysInclusive > 366) throw new SalesReportError('Periode laporan maksimal 366 hari. Persempit tanggal awal dan akhir.');
  return { from, to, daysInclusive };
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SalesReportError('Tanggal harus menggunakan format YYYY-MM-DD.');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new SalesReportError('Tanggal laporan tidak valid.');
  }
  return value;
}

function cleanOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toDouble(input: string): Document {
  return { $convert: { input, to: 'double', onError: 0, onNull: 0 } };
}

function positive(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum<T>(values: T[], getValue: (value: T) => number): number {
  return values.reduce((total, value) => total + getValue(value), 0);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function roundMoney(value: number): number {
  return Math.round(value);
}

function roundPercent(value: number): number {
  return Number(value.toFixed(1));
}

function unavailableBranch(source: SalesReportDataSource): SalesReportBranch {
  return {
    branchId: source.branchId,
    alias: source.alias,
    status: 'unavailable',
    unavailableReason: 'Query penjualan gagal atau melewati batas waktu.',
    invoiceCount: 0,
    detailCount: 0,
    soldWeight: 0,
    salesAmount: 0,
    rowsWithoutWeight: 0,
    jenis: [],
    omittedJenisCount: 0,
  };
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
