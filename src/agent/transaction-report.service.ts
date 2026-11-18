import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { env } from '../config/env';
import { MongoService } from '../database/mongo.service';
import { salesTransactionsPipeline } from './sales-transactions.pipeline';

export type TransactionReportType =
  | 'sales'
  | 'authorization_sales'
  | 'sales_non_cash'
  | 'online_marketplace_price'
  | 'purchase_damaged_condition'
  | 'login_activity';

export interface TransactionReportArgs {
  reportType: TransactionReportType;
  from: string;
  to: string;
  branchIds?: string[];
  marketplace?: string;
  paymentMethod?: NonCashPaymentMethod;
}

export interface TransactionReportSource {
  databaseName: string;
  alias: string;
  branchId: string;
  sourceType: 'branch' | 'central';
}

const MAX_CONCURRENT_SOURCES = 4;
const MAX_REPORT_ROWS = 200;
const MAX_QUERY_TIME_MS = 15_000;
const MAX_REPORT_DAYS = 366;
const HEX_PAIRS = /^(?:[0-9a-f]{2})+$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const NON_CASH_PAYMENT_METHODS = ['DEBET', 'CREDIT', 'TRANSFER'] as const;
type NonCashPaymentMethod = (typeof NON_CASH_PAYMENT_METHODS)[number];

@Injectable()
export class TransactionReportService {
  constructor(private readonly mongo: MongoService) {}

  async read(args: TransactionReportArgs, allowedSources: TransactionReportSource[]) {
    const reportType = parseReportType(args.reportType);
    const range = parseDateRange(args.from, args.to);
    const selectedSources = selectSources(args.branchIds, allowedSources);
    if (!selectedSources.length) throw new BadRequestException('Tidak ada sumber database aktif yang dapat dibaca.');

    const marketplace = cleanMarketplace(args.marketplace);
    const paymentMethod = cleanPaymentMethod(args.paymentMethod);
    const rows = await mapWithConcurrency(selectedSources, MAX_CONCURRENT_SOURCES, async (source) => {
      try {
        const collectionName = collectionFor(reportType);
        const db = this.mongo.getDatabase(source.databaseName);
        const exists = await db.listCollections({ name: collectionName }, { nameOnly: true }).hasNext();
        if (!exists) throw new Error('missing collection');

        const pipeline = buildPipeline(reportType, range, marketplace, paymentMethod);
        pipeline.push({ $limit: MAX_REPORT_ROWS + 1 });
        const aggregateRows = await db.collection(collectionName)
          .aggregate<Document>(pipeline, { allowDiskUse: true, maxTimeMS: MAX_QUERY_TIME_MS })
          .toArray();
        const rawRows: Document[] = reportType === 'sales' ? aggregateRows[0]?.rows ?? [] : aggregateRows;
        const truncated = rawRows.length > MAX_REPORT_ROWS;
        const visibleRows = rawRows.slice(0, MAX_REPORT_ROWS).map((row) => normalizeReportRow(reportType, row));
        return {
          alias: source.alias,
          branchId: source.branchId,
          sourceType: source.sourceType,
          status: 'available' as const,
          rows: visibleRows,
          rowCount: visibleRows.length,
          truncated,
          ...(reportType === 'sales' ? { totals: aggregateRows[0]?.totals?.[0] ?? { invoiceCount: 0, detailCount: 0, salesAmountIdr: 0, weightGram: 0 } } : {}),
        };
      } catch {
        return {
          alias: source.alias,
          branchId: source.branchId,
          sourceType: source.sourceType,
          status: 'unavailable' as const,
          rows: [],
          rowCount: 0,
          truncated: false,
          reason: 'Koleksi tidak tersedia atau pembacaan gagal/melewati batas waktu.',
        };
      }
    });

    return {
      mode: 'transaction-report',
      reportType,
      title: reportTitle(reportType, paymentMethod),
      period: {
        from: range.from,
        to: range.to,
        inclusive: true,
        timeZone: 'Asia/Jakarta',
        dateField: reportType === 'authorization_sales' || reportType === 'login_activity' ? 'datetime' : 'tgl_system',
      },
      policy: reportPolicy(reportType, paymentMethod),
      filters: reportType === 'sales_non_cash' ? { paymentMethod: paymentMethod ?? 'ALL' } : undefined,
      sources: rows,
      partial: rows.some((source) => source.status === 'unavailable'),
      detailLimitPerSource: MAX_REPORT_ROWS,
    };
  }
}

function buildPipeline(
  reportType: TransactionReportType,
  range: { from: string; to: string },
  marketplace?: string,
  paymentMethod?: NonCashPaymentMethod,
): Document[] {
  if (reportType === 'sales') return salesTransactionsPipeline(range, MAX_REPORT_ROWS + 1);
  if (reportType === 'authorization_sales') return buildAuthorizationPipeline(range);
  if (reportType === 'sales_non_cash') return buildSalesNonCashPipeline(range, paymentMethod);
  if (reportType === 'online_marketplace_price') return buildOnlineMarketplacePipeline(range, marketplace);
  if (reportType === 'login_activity') return buildLoginActivityPipeline(range);
  return buildPurchaseDamagedConditionPipeline(range);
}

function buildLoginActivityPipeline(range: { from: string; to: string }): Document[] {
  const loginActions = ['AUTH_LOGIN', 'AUTH_RELOGIN'];
  const logoutActions = ['AUTH_LOGOUT', 'AUTH_AUTO_LOGOUT', 'AUTH_FORCE_LOGOUT'];
  const authenticationActions = [...loginActions, ...logoutActions];
  return [
    {
      $match: {
        arguments: 'AUTHENTICATION',
        action: { $in: authenticationActions },
        input_by: { $type: 'string', $ne: '' },
        datetime: { $lte: jakartaDate(range.to, '23:59:59.999') },
      },
    },
    { $sort: { datetime: -1, _id: -1 } },
    {
      $group: {
        _id: '$input_by',
        latest_action: { $first: '$action' },
        latest_datetime: { $first: '$datetime' },
        login_events_today: {
          $sum: {
            $cond: [
              { $and: [{ $gte: ['$datetime', jakartaDate(range.from, '00:00:00.000')] }, { $in: ['$action', loginActions] }] },
              1,
              0,
            ],
          },
        },
        login_terakhir: {
          $max: {
            $cond: [{ $in: ['$action', loginActions] }, '$datetime', null],
          },
        },
      },
    },
    { $match: { login_events_today: { $gt: 0 } } },
    {
      $project: {
        _id: 0,
        user_id: '$_id',
        status_login: { $cond: [{ $in: ['$latest_action', loginActions] }, 'AKTIF', 'NONAKTIF'] },
        login_terakhir: 1,
        latest_datetime: 1,
      },
    },
    { $sort: { latest_datetime: -1, user_id: 1 } },
  ];
}

function buildAuthorizationPipeline(range: { from: string; to: string }): Document[] {
  return [
    {
      $match: {
        kategori: 'PENJUALAN',
        datetime: { $gte: jakartaDate(range.from, '00:00:00.000'), $lte: jakartaDate(range.to, '23:59:59.999') },
      },
    },
    { $sort: { datetime: -1, _id: -1 } },
    {
      $set: {
        _berat_value: { $convert: { input: '$berat', to: 'double', onError: null, onNull: null } },
        _berat_awal_value: { $convert: { input: '$berat_awal', to: 'double', onError: null, onNull: null } },
      },
    },
    {
      $set: {
        _berat_changed: {
          $cond: [
            { $and: [{ $ne: ['$_berat_value', null] }, { $ne: ['$_berat_awal_value', null] }] },
            { $ne: ['$_berat_value', '$_berat_awal_value'] },
            { $ne: ['$berat', '$berat_awal'] },
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        datetime: 1,
        description: 1,
        keterangan: 1,
        kode_barcode: 1,
        no_faktur: 1,
        input_by: { $ifNull: ['$input_by', '$user_id'] },
        berat: { $cond: ['$_berat_changed', '$berat', '$$REMOVE'] },
        berat_awal: { $cond: ['$_berat_changed', '$berat_awal', '$$REMOVE'] },
      },
    },
  ];
}

function buildSalesNonCashPipeline(range: { from: string; to: string }, paymentMethod?: NonCashPaymentMethod): Document[] {
  const selectedMethods = paymentMethod ? [paymentMethod] : [...NON_CASH_PAYMENT_METHODS];
  const paymentMethodValues = selectedMethods.flatMap(encryptedVariants);
  const categoryValues = encryptedVariants('PENJUALAN');
  const transferReturnCategoryValues = encryptedVariants('KEMBALI TRANSFER');
  const includeTransferReturn = selectedMethods.includes('TRANSFER');
  const methodBranches = NON_CASH_PAYMENT_METHODS.map((method) => ({
    case: { $in: ['$$payment.jenis', encryptedVariants(method)] },
    then: method,
  }));
  return [
    { $match: { tgl_system: { $gte: range.from, $lte: range.to }, status_valid: 'DONE', status_kembali: 'OPEN' } },
    {
      $group: {
        _id: '$no_faktur_group',
        tgl_system: { $first: '$tgl_system' },
        no_faktur: { $first: '$no_faktur_jual' },
        no_faktur_list: { $addToSet: '$no_faktur_jual' },
        no_faktur_group: { $first: '$no_faktur_group' },
        no_faktur_group_user: { $first: '$no_faktur_group_user' },
        kode_barcode: { $addToSet: '$kode_barcode' },
        input_by: { $first: '$input_by' },
        grand_total_transaksi: { $sum: '$harga_total' },
        detail: { $push: { no_faktur: '$no_faktur_jual', kode_barcode: '$kode_barcode' } },
        pembayaran_embedded: {
          $first: {
            $filter: {
              input: { $ifNull: ['$pembayaran', []] },
              as: 'payment',
              cond: {
                $and: [
                  { $in: ['$$payment.jenis', paymentMethodValues] },
                  { $in: ['$$payment.kategori', categoryValues] },
                  { $gt: [{ $ifNull: ['$$payment.jumlah_rp', 0] }, 0] },
                ],
              },
            },
          },
        },
      },
    },
    {
      $lookup: {
        from: 'tt_cash_daily',
        let: { noFakturGroup: '$no_faktur_group' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$deskripsi', '$$noFakturGroup'] },
                  { $gte: ['$tanggal', range.from] },
                  { $lte: ['$tanggal', range.to] },
                ],
              },
              status: 'OPEN',
              $or: [
                { kategori: { $in: categoryValues }, jenis: { $in: paymentMethodValues } },
                ...(includeTransferReturn ? [{ kategori: { $in: transferReturnCategoryValues } }] : []),
              ],
            },
          },
          { $project: { _id: 0, kategori: 1, jenis: 1, fee: 1, jumlah_in: 1, jumlah_out: 1 } },
        ],
        as: 'cash_daily_records',
      },
    },
    {
      $set: {
        pembayaran_cash: {
          $filter: {
            input: '$cash_daily_records',
            as: 'cash',
            cond: { $in: ['$$cash.kategori', categoryValues] },
          },
        },
        pengembalian_transfer: {
          $filter: {
            input: '$cash_daily_records',
            as: 'cash',
            cond: { $in: ['$$cash.kategori', transferReturnCategoryValues] },
          },
        },
      },
    },
    {
      $set: {
        menggunakan_cash_daily: { $gt: [{ $size: '$pembayaran_cash' }, 0] },
        pembayaran_raw: { $cond: [{ $gt: [{ $size: '$pembayaran_cash' }, 0] }, '$pembayaran_cash', '$pembayaran_embedded'] },
        lebih_bayar_transfer: {
          $sum: {
            $map: {
              input: '$pengembalian_transfer',
              as: 'refund',
              in: { $ifNull: ['$$refund.jumlah_out', 0] },
            },
          },
        },
      },
    },
    {
      $set: {
        pembayaran_normalized: {
          $map: {
            input: { $ifNull: ['$pembayaran_raw', []] },
            as: 'payment',
            in: {
              metode: {
                $switch: {
                  branches: methodBranches,
                  default: 'OTHER',
                },
              },
              nominal: {
                $cond: [
                  '$menggunakan_cash_daily',
                  {
                    $cond: [
                      { $ne: [{ $ifNull: ['$$payment.fee', 0] }, 0] },
                      { $divide: [{ $multiply: [{ $ifNull: ['$$payment.jumlah_in', 0] }, 100] }, { $add: [100, { $ifNull: ['$$payment.fee', 0] }] }] },
                      { $ifNull: ['$$payment.jumlah_in', 0] },
                    ],
                  },
                  { $ifNull: ['$$payment.jumlah_rp', 0] },
                ],
              },
            },
          },
        },
      },
    },
    {
      $set: {
        pembayaran: {
          $filter: {
            input: '$pembayaran_normalized',
            as: 'payment',
            cond: { $and: [{ $in: ['$$payment.metode', selectedMethods] }, { $gt: ['$$payment.nominal', 0] }] },
          },
        },
        total_non_cash: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: '$pembayaran_normalized',
                  as: 'payment',
                  cond: { $and: [{ $in: ['$$payment.metode', selectedMethods] }, { $gt: ['$$payment.nominal', 0] }] },
                },
              },
              as: 'payment',
              in: '$$payment.nominal',
            },
          },
        },
      },
    },
    { $match: { total_non_cash: { $gt: 0 } } },
    { $set: { metode_pembayaran: { $setUnion: [[], { $map: { input: '$pembayaran', as: 'payment', in: '$$payment.metode' } }] } } },
    { $sort: { tgl_system: -1, no_faktur_group: -1 } },
    {
      $project: {
        _id: 0,
        tgl_system: 1,
        no_faktur: 1,
        no_faktur_list: 1,
        no_faktur_group_user: 1,
        no_faktur_group: 1,
        kode_barcode: 1,
        input_by: 1,
        grand_total_transaksi: 1,
        metode_pembayaran: 1,
        pembayaran: 1,
        lebih_bayar_transfer: 1,
        detail: 1,
      },
    },
  ];
}

function buildOnlineMarketplacePipeline(range: { from: string; to: string }, marketplace?: string): Document[] {
  const marketplaceFilter = marketplace && !/^(ALL|SEMUA)$/i.test(marketplace)
    ? { kode_marketplace: marketplace }
    : { kode_marketplace: { $ne: '-' } };
  return [
    { $match: { tgl_system: { $gte: range.from, $lte: range.to }, status_valid: 'DONE', status_kembali: 'OPEN', ...marketplaceFilter } },
    { $set: { _nama_barang_lower: { $toLower: { $ifNull: ['$nama_barang', ''] } } } },
    { $set: { _is_packing: { $regexMatch: { input: '$_nama_barang_lower', regex: 'packing' } }, _is_plastik_bening: { $regexMatch: { input: '$_nama_barang_lower', regex: 'plastik\\s*bening' } } } },
    { $set: { _is_biaya_tambahan: { $or: [{ $eq: ['$kode_dept', 'LAINNYA'] }, '$_is_packing', '$_is_plastik_bening'] } } },
    {
      $group: {
        _id: '$no_faktur_group_user',
        tgl_system: { $first: '$tgl_system' },
        kode_marketplace: { $first: '$kode_marketplace' },
        no_faktur_group_user: { $first: '$no_faktur_group_user' },
        input_by: { $first: '$input_by' },
        no_faktur_utama_candidates: { $push: { $cond: [{ $eq: ['$_is_biaya_tambahan', false] }, '$no_faktur_jual', null] } },
        harga_jual_barang: { $sum: { $cond: ['$_is_biaya_tambahan', 0, { $ifNull: ['$harga_jual', 0] }] } },
        ongkos_barang: { $sum: { $cond: ['$_is_biaya_tambahan', 0, { $ifNull: ['$ongkos', 0] }] } },
        biaya_admin: { $max: { $ifNull: ['$biaya_admin', 0] } },
        biaya_packing_field: { $max: { $ifNull: ['$biaya_packing', 0] } },
        biaya_kirim: { $max: { $ifNull: ['$biaya_kirim', 0] } },
        harga_online_barang: { $sum: { $cond: ['$_is_biaya_tambahan', 0, { $ifNull: ['$harga_total', 0] }] } },
        harga_packing_nota: { $sum: { $cond: ['$_is_packing', { $ifNull: ['$harga_total', 0] }, 0] } },
        harga_plastik_bening_nota: { $sum: { $cond: ['$_is_plastik_bening', { $ifNull: ['$harga_total', 0] }, 0] } },
        biaya_tambahan_nota: { $sum: { $cond: ['$_is_biaya_tambahan', { $ifNull: ['$harga_total', 0] }, 0] } },
        harga_online_final: { $sum: { $ifNull: ['$harga_total', 0] } },
        lebih_bayar: { $max: { $ifNull: ['$lebih_bayar', 0] } },
        detail: {
          $push: {
            no_faktur_jual: '$no_faktur_jual',
            kode_barcode: '$kode_barcode',
            kode_dept: '$kode_dept',
            nama_barang: '$nama_barang',
            jenis_detail: {
              $cond: ['$_is_packing', 'PACKING', { $cond: ['$_is_plastik_bening', 'PLASTIK_BENING', { $cond: ['$_is_biaya_tambahan', 'BIAYA_TAMBAHAN', 'BARANG_UTAMA'] }] }],
            },
            harga_jual: { $ifNull: ['$harga_jual', 0] },
            ongkos: { $ifNull: ['$ongkos', 0] },
            biaya_admin: { $ifNull: ['$biaya_admin', 0] },
            biaya_packing: { $ifNull: ['$biaya_packing', 0] },
            biaya_kirim: { $ifNull: ['$biaya_kirim', 0] },
            harga_total: { $ifNull: ['$harga_total', 0] },
          },
        },
      },
    },
    { $set: { no_faktur_utama: { $arrayElemAt: [{ $filter: { input: '$no_faktur_utama_candidates', as: 'no_faktur', cond: { $ne: ['$$no_faktur', null] } } }, 0] } } },
    { $set: { harga_online_komponen_dasar: { $add: ['$harga_jual_barang', '$ongkos_barang', '$biaya_admin', '$harga_packing_nota', '$harga_plastik_bening_nota'] } } },
    { $set: { selisih_rekonsiliasi: { $subtract: ['$harga_online_final', '$harga_online_komponen_dasar'] } } },
    {
      $project: {
        _id: 0,
        tgl_system: 1,
        kode_marketplace: 1,
        no_faktur_group_user: 1,
        input_by: 1,
        no_faktur_utama: 1,
        harga_jual_barang: 1,
        ongkos_barang: 1,
        biaya_admin: 1,
        biaya_packing_field: 1,
        biaya_kirim: 1,
        harga_online_barang: 1,
        harga_packing_nota: 1,
        harga_plastik_bening_nota: 1,
        biaya_tambahan_nota: 1,
        harga_online_komponen_dasar: 1,
        harga_online_final: 1,
        selisih_rekonsiliasi: 1,
        lebih_bayar: 1,
        detail: 1,
      },
    },
    { $sort: { tgl_system: -1, no_faktur_group_user: -1 } },
  ];
}

function buildPurchaseDamagedConditionPipeline(range: { from: string; to: string }): Document[] {
  const plainConditions = ['RUSAK 16K / 17K', 'RUSAK 8K / 9K'];
  const condition16 = [...new Set([plainConditions[0], encryptLegacyAscii(plainConditions[0])])];
  const condition89 = [...new Set([plainConditions[1], encryptLegacyAscii(plainConditions[1])])];
  const storedConditions = [...new Set([...condition16, ...condition89])];
  return [
    { $match: { tgl_system: { $gte: range.from, $lte: range.to }, kondisi: { $in: storedConditions }, status_valid: 'DONE' } },
    { $sort: { tgl_system: -1, no_faktur_beli: 1 } },
    {
      $project: {
        _id: 0,
        no_faktur_beli: 1,
        kode_barcode: 1,
        kondisi: {
          $switch: {
            branches: [
              { case: { $in: ['$kondisi', condition16] }, then: plainConditions[0] },
              { case: { $in: ['$kondisi', condition89] }, then: plainConditions[1] },
            ],
            default: 'KONDISI TIDAK TERIDENTIFIKASI',
          },
        },
        harga_nota: 1,
        harga_beli: '$harga',
        input_by: 1,
      },
    },
  ];
}

function normalizeReportRow(reportType: TransactionReportType, row: Document): Document {
  if (reportType === 'sales') return {
    ...row,
    input_by: typeof row.input_by === 'string' ? decryptLegacyAscii(row.input_by) : row.input_by,
    nama_barang: typeof row.nama_barang === 'string' ? decryptLegacyAscii(row.nama_barang) : row.nama_barang,
  };
  if (reportType === 'online_marketplace_price') return normalizeMarketplaceRow(row);
  if (reportType === 'authorization_sales' || reportType === 'sales_non_cash' || reportType === 'purchase_damaged_condition') {
    if (typeof row.input_by === 'string') return { ...row, input_by: decryptLegacyAscii(row.input_by) };
  }
  return row;
}

function normalizeMarketplaceRow(row: Document): Document {
  const details: UnknownRecord[] = Array.isArray(row.detail)
    ? row.detail.filter(isRecord).map((detail): UnknownRecord => {
      const namaBarang = typeof detail.nama_barang === 'string' ? decryptLegacyAscii(detail.nama_barang) : detail.nama_barang;
      const namaLower = typeof namaBarang === 'string' ? namaBarang.toLowerCase() : '';
      const isPacking = /packing/i.test(namaLower);
      const isPlastikBening = /plastik\s*bening/i.test(namaLower);
      const isBiayaTambahan = String(detail.kode_dept ?? '').toUpperCase() === 'LAINNYA' || isPacking || isPlastikBening;
      return {
        ...detail,
        nama_barang: namaBarang,
        jenis_detail: isPacking ? 'PACKING' : isPlastikBening ? 'PLASTIK_BENING' : isBiayaTambahan ? 'BIAYA_TAMBAHAN' : 'BARANG_UTAMA',
        _isPacking: isPacking,
        _isPlastikBening: isPlastikBening,
        _isBiayaTambahan: isBiayaTambahan,
      };
    })
    : [];
  const mainDetails = details.filter((detail) => detail._isBiayaTambahan !== true);
  const packingDetails = details.filter((detail) => detail._isPacking === true);
  const plastikBeningDetails = details.filter((detail) => detail._isPlastikBening === true);
  const sum = (items: UnknownRecord[], field: string) => items.reduce((total, item) => total + numericValue(item[field]), 0);
  const max = (items: UnknownRecord[], field: string, fallback: unknown) => Math.max(numericValue(fallback), ...items.map((item) => numericValue(item[field])));
  const hargaJualBarang = sum(mainDetails, 'harga_jual');
  const ongkosBarang = sum(mainDetails, 'ongkos');
  const biayaAdmin = max(details, 'biaya_admin', row.biaya_admin);
  const biayaPackingField = max(details, 'biaya_packing', row.biaya_packing_field);
  const biayaKirim = max(details, 'biaya_kirim', row.biaya_kirim);
  const hargaOnlineBarang = sum(mainDetails, 'harga_total');
  const hargaPackingNota = sum(packingDetails, 'harga_total');
  const hargaPlastikBeningNota = sum(plastikBeningDetails, 'harga_total');
  const hargaOnlineFinal = sum(details, 'harga_total');
  const hargaOnlineKomponenDasar = hargaJualBarang + ongkosBarang + biayaAdmin + hargaPackingNota + hargaPlastikBeningNota;
  const mainInvoice = mainDetails.find((detail) => typeof detail['no_faktur_jual'] === 'string')?.['no_faktur_jual'];
  const cleanDetails = details.map(({ _isPacking, _isPlastikBening, _isBiayaTambahan, ...detail }) => detail);
  return {
    ...row,
    input_by: typeof row.input_by === 'string' ? decryptLegacyAscii(row.input_by) : row.input_by,
    no_faktur_utama: mainInvoice ?? row.no_faktur_utama,
    harga_jual_barang: hargaJualBarang,
    ongkos_barang: ongkosBarang,
    biaya_admin: biayaAdmin,
    biaya_packing_field: biayaPackingField,
    biaya_kirim: biayaKirim,
    harga_online_barang: hargaOnlineBarang,
    harga_packing_nota: hargaPackingNota,
    harga_plastik_bening_nota: hargaPlastikBeningNota,
    biaya_tambahan_nota: sum(details.filter((detail) => detail._isBiayaTambahan === true), 'harga_total'),
    harga_online_komponen_dasar: hargaOnlineKomponenDasar,
    harga_online_final: hargaOnlineFinal,
    selisih_rekonsiliasi: hargaOnlineFinal - hargaOnlineKomponenDasar,
    detail: cleanDetails,
  };
}

type UnknownRecord = Record<string, unknown>;

function numericValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return 0;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reportPolicy(reportType: TransactionReportType, paymentMethod?: NonCashPaymentMethod): string {
  if (reportType === 'sales') return 'Penjualan Pusat dan cabang yang diizinkan; status_valid=DONE, status_kembali=OPEN, transaksi tukar dikecualikan. Total mencakup seluruh hasil filter, bukan hanya rincian yang ditampilkan.';
  if (reportType === 'authorization_sales') return 'kategori=PENJUALAN; tt_authorization tidak memiliki status_valid.';
  if (reportType === 'sales_non_cash') return `tt_jual_detail status_valid=DONE/status_kembali=OPEN dihubungkan ke tt_cash_daily melalui no_faktur_group=deskripsi; status pembayaran OPEN, kategori PENJUALAN, metode ${paymentMethod ?? 'DEBET/CREDIT/TRANSFER'}, nominal sudah mengikuti perhitungan fee backend. Jika module transfer lebih membuat kategori KEMBALI TRANSFER, jumlah_out ditampilkan sebagai lebih bayar transfer.`;
  if (reportType === 'online_marketplace_price') return 'tt_jual_detail: status_valid=DONE, status_kembali=OPEN; dikelompokkan berdasarkan no_faktur_group_user dan item packing/plastik bening ikut dihitung.';
  if (reportType === 'login_activity') return 'logs: event autentikasi hari ini; AKTIF berarti event autentikasi terakhir adalah login dan belum ada logout tercatat, NONAKTIF berarti logout/force logout tercatat setelah login.';
  return 'tt_beli_detail: status_valid=DONE; kondisi RUSAK 16K / 17K atau RUSAK 8K / 9K; kondisi terenkripsi dan plaintext sama-sama didukung.';
}

function reportTitle(reportType: TransactionReportType, paymentMethod?: NonCashPaymentMethod): string {
  if (reportType === 'sales') return 'Transaksi Penjualan';
  if (reportType === 'authorization_sales') return 'Rincian Otorisasi Penjualan';
  if (reportType === 'sales_non_cash') return paymentMethod ? `Penjualan ${paymentMethod}` : 'Laporan Penjualan Non-Cash';
  if (reportType === 'online_marketplace_price') return 'Harga Online Marketplace';
  if (reportType === 'login_activity') return 'Login Akun Hari Ini';
  return 'Data - Rongsok Pembelian';
}

function collectionFor(reportType: TransactionReportType): string {
  if (reportType === 'authorization_sales') return 'tt_authorization';
  if (reportType === 'purchase_damaged_condition') return 'tt_beli_detail';
  if (reportType === 'login_activity') return 'logs';
  return 'tt_jual_detail';
}

function parseReportType(value: unknown): TransactionReportType {
  const allowed: TransactionReportType[] = ['sales', 'authorization_sales', 'sales_non_cash', 'online_marketplace_price', 'purchase_damaged_condition', 'login_activity'];
  if (typeof value !== 'string' || !allowed.includes(value as TransactionReportType)) throw new BadRequestException('Jenis laporan transaksi tidak valid.');
  return value as TransactionReportType;
}

function parseDateRange(fromValue: unknown, toValue: unknown): { from: string; to: string } {
  const from = parseDateOnly(fromValue);
  const to = parseDateOnly(toValue);
  const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (from > to) throw new BadRequestException('Tanggal awal harus sebelum atau sama dengan tanggal akhir.');
  if (days > MAX_REPORT_DAYS) throw new BadRequestException('Rentang laporan maksimal 366 hari.');
  return { from, to };
}

function parseDateOnly(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Tanggal harus berformat YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException('Tanggal laporan tidak valid.');
  return value;
}

function jakartaDate(date: string, time: string): Date {
  return new Date(`${date}T${time}+07:00`);
}

function cleanMarketplace(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 64) throw new BadRequestException('Kode marketplace tidak valid.');
  const marketplace = value.trim();
  return marketplace || undefined;
}

function cleanPaymentMethod(value: unknown): NonCashPaymentMethod | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException('Metode pembayaran tidak valid.');
  const method = value.trim().toUpperCase();
  if (!method || method === 'ALL' || method === 'SEMUA') return undefined;
  if (!NON_CASH_PAYMENT_METHODS.includes(method as NonCashPaymentMethod)) throw new BadRequestException('Metode pembayaran harus DEBET, CREDIT, atau TRANSFER.');
  return method as NonCashPaymentMethod;
}

function encryptedVariants(value: string): string[] {
  return [...new Set([value, encryptLegacyAscii(value)])];
}

function selectSources(branchIds: unknown, sources: TransactionReportSource[]): TransactionReportSource[] {
  if (branchIds === undefined) return sources;
  if (!Array.isArray(branchIds) || branchIds.length < 1 || branchIds.length > 100 || branchIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new BadRequestException('branchIds tidak valid.');
  }
  const requested = new Set(branchIds.map((id) => id.trim()));
  const selected = sources.filter((source) => requested.has(source.branchId));
  if (selected.length !== requested.size) throw new BadRequestException('Satu atau beberapa branchId tidak tersedia untuk akun ini.');
  return selected;
}

function encryptLegacyAscii(value: string): string {
  const key = env.encKeyDec;
  if (!key) return value;
  let encrypted = '';
  let keyIndex = 0;
  for (const character of value) {
    encrypted += (character.charCodeAt(0) + key.charCodeAt(keyIndex)).toString(16);
    if (keyIndex === key.length - 1) keyIndex = 0;
    keyIndex += 1;
  }
  return encrypted.toUpperCase();
}

function decryptLegacyAscii(value: string): string {
  const key = env.encKeyDec;
  const encrypted = value.trim();
  if (!key || !HEX_PAIRS.test(encrypted)) return value;
  let decrypted = '';
  let keyIndex = 0;
  for (let index = 0; index < encrypted.length; index += 2) {
    const characterCode = Number.parseInt(encrypted.slice(index, index + 2), 16) - key.charCodeAt(keyIndex);
    if (!Number.isFinite(characterCode) || characterCode < 0 || characterCode > 0xffff) return value;
    decrypted += String.fromCharCode(characterCode);
    if (keyIndex === key.length - 1) keyIndex = 0;
    keyIndex += 1;
  }
  const candidate = decrypted.trim();
  if (!candidate || CONTROL_CHARACTERS.test(candidate)) return value;
  return encryptLegacyAscii(candidate) === encrypted.toUpperCase() ? candidate : value;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    output.push(...await Promise.all(items.slice(offset, offset + concurrency).map(worker)));
  }
  return output;
}
