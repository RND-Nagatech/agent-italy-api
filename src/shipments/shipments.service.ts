import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { Document, ObjectId } from 'mongodb';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { CacheManagementService } from '../cache/cache-management.service';
import { AuthPrincipal } from '../users/user.types';
import { Role } from '../users/roles';
import { ListShipmentsQueryDto } from './dto/list-shipments-query.dto';
import { ShipmentDetailQueryDto } from './dto/shipment-detail-query.dto';
import {
  ShipmentDetailResult,
  ShipmentItem,
  ShipmentListResult,
  ShipmentPeriod,
  ShipmentStatus,
  ShipmentSummary,
} from './shipment.types';

interface ShipmentSourceDocument extends Document {
  _id: ObjectId;
  no_kirim?: unknown;
  tujuan?: unknown;
  kode_barang?: unknown;
  kode_barcode?: unknown;
  nama_barang?: unknown;
  nama_atribut?: unknown;
  kode_group?: unknown;
  kode_dept?: unknown;
  warna?: unknown;
  status_terima?: unknown;
  berat?: unknown;
  input_date?: unknown;
  receive_date?: unknown;
}

interface ShipmentFacetResult extends Document {
  items: ShipmentSummary[];
  metadata: Array<{ total: number; sourceRecordCount: number }>;
  statusCounts: Array<{ _id: ShipmentStatus; count: number }>;
  inProcessByDestination: Array<{ _id: string; shipmentCount: number }>;
}

type CachedShipmentListResult = ShipmentListResult & { matchingSourceRecords: number };

const ITEM_PROJECTION = {
  _id: 1,
  no_kirim: 1,
  tujuan: 1,
  kode_barang: 1,
  kode_barcode: 1,
  nama_barang: 1,
  nama_atribut: 1,
  kode_group: 1,
  kode_dept: 1,
  warna: 1,
  status_terima: 1,
  berat: 1,
  input_date: 1,
  receive_date: 1,
} as const;

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly cache: CacheManagementService,
  ) {}

  private get shipments() {
    return this.mongo
      .getDatabase(env.shipmentSourceDatabaseName)
      .collection<ShipmentSourceDocument>('tt_kirim_barang');
  }

  refreshCache() {
    return {
      clearedEntries: this.cache.clearByPrefix('shipments:'),
      refreshedAt: new Date().toISOString(),
    };
  }

  async list(
    query: ListShipmentsQueryDto,
    principal: AuthPrincipal,
  ): Promise<ShipmentListResult> {
    const diagnosticsEnabled = query.debug === '1';
    if (diagnosticsEnabled && principal.role !== Role.Admin) {
      throw new ForbiddenException('Query diagnostics are available to administrator accounts only');
    }

    const period = query.period ?? ShipmentPeriod.All;
    const serviceStartedAt = diagnosticsEnabled ? performance.now() : 0;
    let mongoRoundTripMs: number | null = null;
    const scope = principal.role === Role.Branch ? principal.branchId?.trim() ?? '' : 'global';
    const key = `shipments:list:${JSON.stringify({
      databaseName: env.shipmentSourceDatabaseName,
      role: principal.role,
      scope,
      period,
      search: query.search?.trim() ?? '',
      status: query.status ?? 'all',
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    })}`;
    const { value, cacheStatus } = await this.cache.getOrLoadWithStatus(key, () => this.loadList(
      query,
      principal,
      period,
      diagnosticsEnabled ? (durationMs) => { mongoRoundTripMs = durationMs; } : undefined,
    ));
    const { matchingSourceRecords, ...response } = value;
    if (!diagnosticsEnabled) return response;

    return {
      ...response,
      debug: {
        source: `${env.shipmentSourceDatabaseName}.tt_kirim_barang`,
        cacheStatus,
        mongoRoundTripMs,
        serviceMs: elapsedMs(serviceStartedAt),
        page: response.page,
        pageSize: response.pageSize,
        totalMatchingGroups: response.total,
        returnedItems: response.items.length,
        matchingSourceRecords,
        period,
        status: query.status ?? 'all',
        searchApplied: Boolean(query.search?.trim()),
      },
    };
  }

  private async loadList(
    query: ListShipmentsQueryDto,
    principal: AuthPrincipal,
    period: ShipmentPeriod,
    onMongoRoundTrip?: (durationMs: number) => void,
  ): Promise<CachedShipmentListResult> {
    const search = query.search?.trim();
    const stages: Document[] = [
      ...this.summaryStages(this.sourceMatch(principal, search, undefined, undefined, period)),
    ];

    const offset = (query.page - 1) * query.pageSize;
    stages.push({
      $facet: {
        items: [
          ...(query.status ? [{ $match: { status: query.status } }] : []),
          { $sort: { [query.sortBy ?? 'lastInputAt']: query.sortDirection === 'asc' ? 1 : -1, _id: -1 } },
          { $skip: offset },
          { $limit: query.pageSize },
          {
            $project: {
              _id: 0,
              noKirim: '$_id',
              destination: 1,
              destinationMismatch: 1,
              recordCount: 1,
              receivedRecordCount: 1,
              pendingRecordCount: 1,
              unknownStatusRecordCount: 1,
              totalWeight: 1,
              status: 1,
              lastInputAt: 1,
            },
          },
        ],
        metadata: [
          ...(query.status ? [{ $match: { status: query.status } }] : []),
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              sourceRecordCount: { $sum: '$recordCount' },
            },
          },
        ],
        statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        inProcessByDestination: [
          {
            $match: {
              status: { $in: [ShipmentStatus.Pending, ShipmentStatus.Partial] },
              destination: { $type: 'string' },
              destinationMismatch: false,
            },
          },
          { $group: { _id: '$destination', shipmentCount: { $sum: 1 } } },
          { $sort: { shipmentCount: -1, _id: 1 } },
          { $limit: 5 },
        ],
      },
    });

    const mongoStartedAt = onMongoRoundTrip ? performance.now() : 0;
    const [result] = await this.shipments
      .aggregate<ShipmentFacetResult>(stages, {
        allowDiskUse: true,
        maxTimeMS: 30_000,
      })
      .toArray();
    if (onMongoRoundTrip) onMongoRoundTrip(elapsedMs(mongoStartedAt));
    const total = result?.metadata[0]?.total ?? 0;
    const statusCounts = Object.fromEntries(
      (result?.statusCounts ?? []).map(({ _id, count }) => [_id, count]),
    ) as Record<ShipmentStatus, number>;

    return {
      items: result?.items ?? [],
      matchingSourceRecords: result?.metadata[0]?.sourceRecordCount ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      statusCounts: {
        [ShipmentStatus.Received]: statusCounts[ShipmentStatus.Received] ?? 0,
        [ShipmentStatus.Pending]: statusCounts[ShipmentStatus.Pending] ?? 0,
        [ShipmentStatus.Partial]: statusCounts[ShipmentStatus.Partial] ?? 0,
        [ShipmentStatus.Review]: statusCounts[ShipmentStatus.Review] ?? 0,
      },
      inProcessByDestination: (result?.inProcessByDestination ?? []).map((entry) => ({
        destination: entry._id,
        shipmentCount: entry.shipmentCount,
      })),
    };
  }

  async detail(
    noKirim: string,
    query: ShipmentDetailQueryDto,
    principal: AuthPrincipal,
  ): Promise<ShipmentDetailResult> {
    if (!noKirim.trim() || noKirim.length > 120) {
      throw new BadRequestException('Invalid shipment number');
    }

    const scope = principal.role === Role.Branch ? principal.branchId?.trim() ?? '' : 'global';
    const key = `shipments:detail:${JSON.stringify({
      databaseName: env.shipmentSourceDatabaseName,
      role: principal.role,
      scope,
      noKirim,
      itemLimit: query.itemLimit,
      itemCursor: query.itemCursor ?? null,
    })}`;
    return this.cache.getOrLoad(key, () => this.loadDetail(noKirim, query, principal));
  }

  private async loadDetail(
    noKirim: string,
    query: ShipmentDetailQueryDto,
    principal: AuthPrincipal,
  ): Promise<ShipmentDetailResult> {
    const match = this.sourceMatch(principal, undefined, noKirim);
    const summaryStages = this.summaryStages(match);
    summaryStages.push(
      {
        $project: {
          _id: 0,
          noKirim: '$_id',
          destination: 1,
          destinationMismatch: 1,
          recordCount: 1,
          receivedRecordCount: 1,
          pendingRecordCount: 1,
          unknownStatusRecordCount: 1,
          totalWeight: 1,
          status: 1,
          lastInputAt: 1,
        },
      },
      { $limit: 1 },
    );

    const [summary] = await this.shipments
      .aggregate<ShipmentSummary>(summaryStages, {
        allowDiskUse: true,
        maxTimeMS: 30_000,
      })
      .toArray();

    if (!summary) throw new NotFoundException('Shipment not found');

    const itemFilter = this.sourceMatch(
      principal,
      undefined,
      noKirim,
      query.itemCursor ? new ObjectId(query.itemCursor) : undefined,
    );

    const results = await this.shipments
      .find(itemFilter, {
        projection: ITEM_PROJECTION,
        maxTimeMS: 30_000,
      })
      .sort({ _id: 1 })
      .limit(query.itemLimit + 1)
      .toArray();
    const hasMore = results.length > query.itemLimit;
    const page = hasMore ? results.slice(0, query.itemLimit) : results;
    const items = page.map(toShipmentItem);

    return {
      summary,
      items,
      itemLimit: query.itemLimit,
      nextItemCursor: hasMore ? items[items.length - 1].itemId : null,
    };
  }

  private sourceMatch(
    principal: AuthPrincipal,
    search?: string,
    noKirim?: string,
    itemCursor?: ObjectId,
    period?: ShipmentPeriod,
  ): Document {
    const conditions: Document[] = [
      { no_kirim: { $type: 'string', $ne: '' } },
    ];

    if (search) {
      conditions.push({ no_kirim: { $regex: `^${escapeRegex(search)}` } });
    }
    if (noKirim !== undefined) conditions.push({ no_kirim: noKirim });
    if (itemCursor) conditions.push({ _id: { $gt: itemCursor } });
    if (period && period !== ShipmentPeriod.All) {
      const from = getJakartaPeriodStart(period);
      conditions.push({ input_date: { $gte: from, $lte: new Date() } });
    }

    if (principal.role === Role.Branch) {
      const branchId = principal.branchId?.trim();
      if (!branchId) throw new ForbiddenException('Branch account has no branch scope');
      conditions.push({ tujuan: branchId });
    }

    return { $and: conditions };
  }

  private summaryStages(match: Document): Document[] {
    return [
      { $match: match },
      { $project: { no_kirim: 1, tujuan: 1, input_date: 1, status_terima: 1, berat: 1 } },
      {
        $group: {
          _id: '$no_kirim',
          destinations: { $addToSet: { $ifNull: ['$tujuan', null] } },
          lastInputAt: { $max: { $ifNull: ['$input_date', null] } },
          recordCount: { $sum: 1 },
          receivedRecordCount: {
            $sum: { $cond: [{ $eq: ['$status_terima', 'CLOS'] }, 1, 0] },
          },
          pendingRecordCount: {
            $sum: { $cond: [{ $eq: ['$status_terima', 'OPEN'] }, 1, 0] },
          },
          totalWeight: {
            $sum: {
              $convert: {
                input: '$berat',
                to: 'double',
                onError: 0,
                onNull: 0,
              },
            },
          },
          unknownStatusRecordCount: {
            $sum: {
              $cond: [
                {
                  $in: [
                    { $ifNull: ['$status_terima', null] },
                    ['CLOS', 'OPEN'],
                  ],
                },
                0,
                1,
              ],
            },
          },
        },
      },
      {
        $addFields: {
          destination: {
            $cond: [
              { $eq: [{ $size: '$destinations' }, 1] },
              { $arrayElemAt: ['$destinations', 0] },
              null,
            ],
          },
          destinationMismatch: { $gt: [{ $size: '$destinations' }, 1] },
          status: {
            $switch: {
              branches: [
                { case: { $gt: ['$unknownStatusRecordCount', 0] }, then: ShipmentStatus.Review },
                {
                  case: {
                    $and: [
                      { $gt: ['$receivedRecordCount', 0] },
                      { $gt: ['$pendingRecordCount', 0] },
                    ],
                  },
                  then: ShipmentStatus.Partial,
                },
                { case: { $eq: ['$receivedRecordCount', '$recordCount'] }, then: ShipmentStatus.Received },
                { case: { $eq: ['$pendingRecordCount', '$recordCount'] }, then: ShipmentStatus.Pending },
              ],
              default: ShipmentStatus.Review,
            },
          },
        },
      },
    ];
  }
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

function getJakartaPeriodStart(period: ShipmentPeriod): Date {
  const jakartaNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const year = jakartaNow.getUTCFullYear();
  const monthIndex = jakartaNow.getUTCMonth();
  const day = jakartaNow.getUTCDate();

  if (period === ShipmentPeriod.ThisMonth) {
    return new Date(Date.UTC(year, monthIndex, 1) - 7 * 60 * 60 * 1000);
  }

  const months = period === ShipmentPeriod.ThreeMonths ? 3 : period === ShipmentPeriod.SixMonths ? 6 : 12;
  const totalMonths = year * 12 + monthIndex - months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const targetDay = Math.min(day, new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate());
  const localDate = Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    jakartaNow.getUTCHours(),
    jakartaNow.getUTCMinutes(),
    jakartaNow.getUTCSeconds(),
    jakartaNow.getUTCMilliseconds(),
  );
  return new Date(localDate - 7 * 60 * 60 * 1000);
}

function escapeRegex(value: string): string {
  const metaCharacters = new Set([
    '.', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|',
    String.fromCharCode(92),
  ]);
  return [...value]
    .map((character) =>
      metaCharacters.has(character)
        ? String.fromCharCode(92) + character
        : character,
    )
    .join('');
}

function toShipmentItem(document: ShipmentSourceDocument): ShipmentItem {
  return {
    itemId: document._id.toHexString(),
    noKirim: safeString(document.no_kirim) ?? '',
    destination: safeString(document.tujuan),
    productCode: safeString(document.kode_barang),
    barcode: safeString(document.kode_barcode),
    name: safeString(document.nama_barang),
    attribute: safeString(document.nama_atribut),
    groupCode: safeString(document.kode_group),
    departmentCode: safeString(document.kode_dept),
    color: safeString(document.warna),
    receiptStatus: safeString(document.status_terima),
    weight: safeWeight(document.berat),
    inputDate: safeDate(document.input_date),
    receiveDate: safeDate(document.receive_date),
  };
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 500) : null;
}

function safeWeight(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const parsed = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : typeof value === 'object'
      ? Number(String(value))
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function safeDate(value: unknown): Date | string | null {
  return value instanceof Date || typeof value === 'string' ? value : null;
}
