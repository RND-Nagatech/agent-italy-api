import { ForbiddenException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { CacheManagementService } from '../cache/cache-management.service';
import { MongoService } from '../database/mongo.service';
import { ShipmentPeriod } from '../shipments/shipment.types';
import { Role } from '../users/roles';
import { AuthPrincipal } from '../users/user.types';
import { AgentDataSourceConfig } from '../sources/source.types';
import { SalesSummaryQueryDto } from './dto/sales-summary-query.dto';
import { SalesBranchSummary, SalesSummaryResult } from './sales.types';
import { validSalesMatch } from './sales-query-policy';

interface SalesDataSource {
  databaseName: string;
  alias: string;
  branchId: string;
}

interface SalesAggregateRow {
  invoiceCount: number;
  detailCount: number;
  quantity: number;
  totalWeight: number;
  salesAmount: number;
}

const MAX_CONCURRENT_BRANCH_QUERIES = 4;

@Injectable()
export class SalesService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  private get sources() {
    return this.mongo.db.collection<AgentDataSourceConfig>('shipment_sources');
  }

  async summary(
    query: SalesSummaryQueryDto,
    principal: AuthPrincipal,
  ): Promise<SalesSummaryResult> {
    const period = query.period ?? ShipmentPeriod.ThisMonth;
    const branchScope = principal.role === Role.Branch ? principal.branchId?.trim() ?? '' : null;
    if (principal.role === Role.Branch && !branchScope) {
      throw new ForbiddenException('Branch account has no branch scope');
    }

    const sourceFilter: Document = { active: true, sourceType: { $ne: 'central' } };
    if (branchScope) sourceFilter.branchId = branchScope;

    const sources = await this.sources
      .find(sourceFilter, {
        projection: { _id: 0, databaseName: 1, alias: 1, branchId: 1 },
      })
      .sort({ branchId: 1, alias: 1 })
      .toArray() as SalesDataSource[];

    if (branchScope && sources.length === 0) {
      throw new ForbiddenException('No active data source configured for this branch');
    }

    const dateRange = getPeriodRange(period);
    const key = `sales:summary:v2:${JSON.stringify({
      period,
      dateFrom: dateRange.from,
      dateTo: dateRange.to,
      role: principal.role,
      branchScope,
      sources: sources.map(({ databaseName, alias, branchId }) => ({ databaseName, alias, branchId })),
    })}`;

    return this.cache.getOrLoad(key, async () => {
      const branches = await mapWithConcurrency(
        sources,
        MAX_CONCURRENT_BRANCH_QUERIES,
        async (source) => this.aggregateBranch(source, dateRange),
      );
      return buildResult(period, dateRange, branches);
    });
  }

  private async aggregateBranch(
    source: SalesDataSource,
    dateRange: { from: string | null; to: string | null },
  ): Promise<SalesBranchSummary> {
    const match: Document = validSalesMatch();
    if (dateRange.from && dateRange.to) {
      match.tgl_system = { $gte: dateRange.from, $lte: dateRange.to };
    }

    const pipeline: Document[] = [
      { $match: match },
      {
        $project: {
          invoiceNumber: '$no_faktur_jual',
          quantity: toDouble('$qty'),
          weight: toDouble('$berat'),
          salesAmount: toDouble('$harga_total'),
        },
      },
      {
        $group: {
          _id: '$invoiceNumber',
          detailCount: { $sum: 1 },
          quantity: { $sum: '$quantity' },
          totalWeight: { $sum: '$weight' },
          salesAmount: { $sum: '$salesAmount' },
        },
      },
      {
        $group: {
          _id: null,
          invoiceCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: [{ $type: '$_id' }, 'string'] },
                    { $ne: ['$_id', ''] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          detailCount: { $sum: '$detailCount' },
          quantity: { $sum: '$quantity' },
          totalWeight: { $sum: '$totalWeight' },
          salesAmount: { $sum: '$salesAmount' },
        },
      },
      { $project: { _id: 0, invoiceCount: 1, detailCount: 1, quantity: 1, totalWeight: 1, salesAmount: 1 } },
    ];

    const [aggregate] = await this.mongo
      .getDatabase(source.databaseName)
      .collection('tt_jual_detail')
      .aggregate<SalesAggregateRow>(pipeline, { allowDiskUse: true, maxTimeMS: 30_000 })
      .toArray();

    return {
      branchId: source.branchId,
      alias: source.alias,
      invoiceCount: aggregate?.invoiceCount ?? 0,
      detailCount: aggregate?.detailCount ?? 0,
      quantity: aggregate?.quantity ?? 0,
      totalWeight: aggregate?.totalWeight ?? 0,
      salesAmount: aggregate?.salesAmount ?? 0,
    };
  }
}

function toDouble(input: string): Document {
  return { $convert: { input, to: 'double', onError: 0, onNull: 0 } };
}

function buildResult(
  period: ShipmentPeriod,
  dateRange: { from: string | null; to: string | null },
  branches: SalesBranchSummary[],
): SalesSummaryResult {
  return {
    period,
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    statusValid: 'DONE',
    totals: branches.reduce((total, branch) => ({
      branchCount: total.branchCount + 1,
      invoiceCount: total.invoiceCount + branch.invoiceCount,
      detailCount: total.detailCount + branch.detailCount,
      quantity: total.quantity + branch.quantity,
      totalWeight: total.totalWeight + branch.totalWeight,
      salesAmount: total.salesAmount + branch.salesAmount,
    }), {
      branchCount: 0,
      invoiceCount: 0,
      detailCount: 0,
      quantity: 0,
      totalWeight: 0,
      salesAmount: 0,
    }),
    branches,
  };
}

function getPeriodRange(period: ShipmentPeriod): { from: string | null; to: string | null } {
  if (period === ShipmentPeriod.All) return { from: null, to: null };

  const jakartaToday = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const year = jakartaToday.getUTCFullYear();
  const monthIndex = jakartaToday.getUTCMonth();
  const day = jakartaToday.getUTCDate();
  const to = formatDate(year, monthIndex, day);

  if (period === ShipmentPeriod.ThisMonth) {
    return { from: formatDate(year, monthIndex, 1), to };
  }

  const months = period === ShipmentPeriod.ThreeMonths ? 3 : period === ShipmentPeriod.SixMonths ? 6 : 12;
  const totalMonths = year * 12 + monthIndex - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const targetDay = Math.min(day, new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate());
  return { from: formatDate(targetYear, targetMonth, targetDay), to };
}

function formatDate(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let failure: unknown;
  let hasFailure = false;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!hasFailure) {
      const index = nextIndex++;
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
