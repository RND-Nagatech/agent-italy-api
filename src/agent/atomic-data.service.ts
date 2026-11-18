import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { env } from '../config/env';
import { validSalesMatch } from '../sales/sales-query-policy';
import { decryptDepartmentName } from '../common/department-name';

export type AtomicKind = 'sales' | 'stock' | 'shipments' | 'buyback';
export type AtomicSource = { databaseName: string; branchId: string; alias: string; sourceType: 'branch' | 'central' };
export interface AtomicArgs { branchIds?: string[]; sourceType?: 'branch' | 'central'; jenisCode?: string; from?: string; to?: string; shipmentStatus?: 'OPEN' | 'CLOS' | 'all' }
const convert = (field: string) => ({ $convert: { input: `$${field}`, to: 'double', onError: 0, onNull: 0 } });
const asDate = (field: string) => ({ $convert: { input: `$${field}`, to: 'date', onError: null, onNull: null } });

export function atomicRange(args: AtomicArgs) {
  const valid = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(args.from) || !valid(args.to) || args.from > args.to) throw new BadRequestException('from/to wajib berupa tanggal kalender YYYY-MM-DD yang valid dan berurutan.');
  const from = new Date(`${args.from}T00:00:00+07:00`);
  const to = new Date(`${args.to}T00:00:00+07:00`); to.setUTCDate(to.getUTCDate() + 1);
  if (+to - +from > 3660 * 86400000) throw new BadRequestException('Rentang maksimum 10 tahun.');
  return { from, to };
}
export function atomicPipeline(kind: AtomicKind, args: AtomicArgs, destination?: string): Document[] {
  const match: Document = kind === 'sales' ? validSalesMatch() : kind === 'stock' ? { status_hancur: false, $or: [{ stock_on_hand: { $gt: 0 } }, { stock_on_hand: null, qty: { $gt: 0 } }] } : kind === 'buyback' ? { status_sortir: false, status_hancur: false, status_valid: { $ne: 'CANC' } } : { tujuan: destination, status_terima: args.shipmentStatus && args.shipmentStatus !== 'all' ? args.shipmentStatus : { $in: ['OPEN', 'CLOS'] } };
  if (args.jenisCode) match.kode_dept = args.jenisCode;
  const stages: Document[] = [{ $match: match }];
  if (kind !== 'stock') {
    const range = atomicRange(args);
    if (kind === 'sales') stages.push({ $match: { tgl_system: { $gte: args.from, $lte: args.to } } });
    else stages.push({ $set: { _periodDate: kind === 'buyback' ? { $ifNull: [asDate('input_date'), asDate('tgl_system')] } : asDate('input_date') } }, { $match: { _periodDate: { $gte: range.from, $lt: range.to } } });
  }
  const rawWeight = convert('berat');
  const quantityPcs = { $convert: { input: { $ifNull: ['$stock_on_hand', '$qty'] }, to: 'double', onError: 0, onNull: 0 } };
  const weight = kind === 'stock' ? { $multiply: [rawWeight, quantityPcs] } : rawWeight;
  stages.push({ $project: { jenis: { $cond: [{ $eq: [{ $type: '$kode_dept' }, 'string'] }, '$kode_dept', 'TANPA_JENIS'] }, weight, quantityPcs: kind === 'stock' ? quantityPcs : { $literal: 0 }, hasWeight: { $gt: [rawWeight, 0] }, amount: kind === 'sales' ? convert('harga_total') : { $literal: 0 }, shipmentStatus: kind === 'shipments' ? '$status_terima' : { $literal: '' } } },
    { $group: { _id: { jenis: '$jenis', status: '$shipmentStatus' }, quantityPcs: { $sum: '$quantityPcs' }, weightGram: { $sum: { $cond: ['$hasWeight', '$weight', 0] } }, salesAmountIdr: { $sum: '$amount' }, recordsWithoutWeight: { $sum: { $cond: ['$hasWeight', 0, 1] } } } },
    { $sort: { ...(kind === 'stock' ? { quantityPcs: -1 } : { weightGram: -1 }), '_id.jenis': 1, '_id.status': 1 } },
    { $facet: { rows: [{ $limit: 200 }], totals: [{ $group: { _id: null, quantityPcs: { $sum: '$quantityPcs' }, weightGram: { $sum: '$weightGram' }, salesAmountIdr: { $sum: '$salesAmountIdr' }, recordsWithoutWeight: { $sum: '$recordsWithoutWeight' }, groups: { $sum: 1 } } }] } });
  return stages;
}

@Injectable()
export class AtomicDataService {
  constructor(private readonly mongo: MongoService) {}
  async read(kind: AtomicKind, args: AtomicArgs, allowed: AtomicSource[]) {
    if (!['sales', 'stock', 'shipments', 'buyback'].includes(kind)) throw new BadRequestException('Jenis fungsi data tidak dikenal.');
    if (args.branchIds !== undefined && (!Array.isArray(args.branchIds) || !args.branchIds.length || args.branchIds.length > 100 || args.branchIds.some(id => typeof id !== 'string' || !id.trim()))) throw new BadRequestException('branchIds harus berisi 1–100 ID sumber.');
    if (args.jenisCode !== undefined && (typeof args.jenisCode !== 'string' || !args.jenisCode.trim() || args.jenisCode.length > 64)) throw new BadRequestException('Kode Jenis tidak valid.');
    if (args.sourceType !== undefined && (!['branch', 'central'].includes(args.sourceType) || kind !== 'stock')) throw new BadRequestException('sourceType hanya berlaku untuk pembacaan stok saat ini.');
    if (args.shipmentStatus !== undefined && !['OPEN', 'CLOS', 'all'].includes(args.shipmentStatus)) throw new BadRequestException('Status pengiriman tidak valid.');
    if (kind === 'stock' && (args.from || args.to)) throw new BadRequestException('Stok membaca posisi saat ini; jangan kirim from/to.');
    if (kind !== 'stock') atomicRange(args);
    const eligible = allowed.filter(source => (kind === 'stock' || kind === 'sales' || source.sourceType === 'branch') && (!args.sourceType || source.sourceType === args.sourceType));
    if (args.branchIds?.some(id => !eligible.some(source => source.branchId === id))) throw new BadRequestException('ID sumber tidak tersedia atau tidak diizinkan untuk fungsi ini.');
    const selected = eligible.filter(source => !args.branchIds || args.branchIds.includes(source.branchId));
    if (!selected.length) throw new BadRequestException('Tidak ada sumber aktif yang diizinkan.');
    const collection = { sales: 'tt_jual_detail', stock: 'tm_barang', shipments: 'tt_kirim_barang', buyback: 'tt_beli_detail' }[kind];
    const results: Record<string, unknown>[] = [];
    // Bound fan-out across branch databases; a tool batch also has its own concurrency cap.
    for (let offset = 0; offset < selected.length; offset += 2) {
      results.push(...await Promise.all(selected.slice(offset, offset + 2).map(async source => {
        try {
          const db = this.mongo.getDatabase(kind === 'shipments' ? env.shipmentSourceDatabaseName : source.databaseName);
          if (!await db.listCollections({ name: collection }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
          const [facet] = await db.collection(collection).aggregate(atomicPipeline(kind, args, source.branchId), { maxTimeMS: 15000, allowDiskUse: true }).toArray();
          const totals = facet?.totals?.[0] ?? { quantityPcs: 0, weightGram: 0, salesAmountIdr: 0, recordsWithoutWeight: 0, groups: 0 };
          let namesUnavailable = false;
          let names = new Map<string, string>();
          try {
            const departments = await this.mongo.getDatabase(source.databaseName).collection('tm_dept').find({}, { projection: { kode_dept: 1, nama_dept: 1 } }).limit(2000).toArray();
            names = new Map(departments.map(row => [String(row.kode_dept), decryptDepartmentName(row.nama_dept) || String(row.kode_dept)]));
          } catch { namesUnavailable = true; }
          return { branchId: source.branchId, alias: source.alias, sourceType: source.sourceType, status: 'available', totals: { ...(kind === 'stock' ? { quantityPcs: totals.quantityPcs } : {}), weightGram: totals.weightGram, ...(kind === 'sales' ? { salesAmountIdr: totals.salesAmountIdr } : {}), recordsWithoutWeight: totals.recordsWithoutWeight }, groups: totals.groups, truncated: totals.groups > 200, namesUnavailable, jenis: (facet?.rows ?? []).map((row: Document) => ({ kode: row._id.jenis, nama: names.get(row._id.jenis) ?? row._id.jenis, ...(kind === 'stock' ? { quantityPcs: row.quantityPcs } : {}), ...(kind === 'shipments' ? { shipmentStatus: row._id.status } : {}), weightGram: row.weightGram, ...(kind === 'sales' ? { salesAmountIdr: row.salesAmountIdr } : {}), recordsWithoutWeight: row.recordsWithoutWeight })) };
        } catch { return { branchId: source.branchId, alias: source.alias, status: 'unavailable', reason: 'Koleksi tidak tersedia atau pembacaan gagal/melewati batas waktu; bukan stok/penjualan nol.' }; }
      })));
    }
    return { mode: `atomic-${kind}`, asOf: new Date().toISOString(), period: kind === 'stock' ? null : { from: args.from, to: args.to, inclusive: true, timeZone: 'Asia/Jakarta', dateField: kind === 'sales' ? 'tgl_system' : kind === 'buyback' ? 'input_date, fallback tgl_system' : 'input_date (tanggal dikirim, bukan tanggal diterima)' }, collection, policy: kind === 'stock' ? 'Stok fisik saat ini: status_hancur=false; pcs=sum(stock_on_hand), dan hanya jika stock_on_hand null/tidak ada gunakan qty; gram=sum(berat×pcs). Bukan stok historis. OPEN tidak termasuk.' : kind === 'sales' ? 'status_kembali=OPEN, status_valid=DONE, transaksi tukar dikecualikan; gram=sum(berat).' : kind === 'buyback' ? 'Kandidat buyback saat ini yang tercatat pada periode: status_sortir=false, status_hancur=false, status_valid!=CANC; bukan saldo historis.' : 'Sumber pengiriman hanya database Pusat; tujuan=branchId terpilih, status OPEN/CLOS dipisah. CLOS sudah termasuk stok fisik; jangan dijumlahkan kembali.', branches: results, partial: results.some(row => row.status === 'unavailable'), detailLimitPerSource: 200 };
  }
}
