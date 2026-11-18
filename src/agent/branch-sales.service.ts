import { BadRequestException, Injectable } from '@nestjs/common';
import { Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { decryptDepartmentName } from '../common/department-name';
import { validSalesMatch } from '../sales/sales-query-policy';
import { atomicRange, AtomicSource } from './atomic-data.service';
export interface BranchSalesArgs {
  from: string; to: string; branchIds?: string[]; jenisCode?: string; salesCode?: string;
  includeJenis?: boolean; page?: number; pageSize?: number; jenisPage?: number; jenisPageSize?: number;
}
const number = (field: string) => ({ $convert: { input: `$${field}`, to: 'double', onNull: 0, onError: 0 } });
const code = (field: string, fallback: string) => ({ $let: { vars: { code: { $trim: { input: { $convert: { input: `$${field}`, to: 'string', onError: '', onNull: '' } } } } }, in: { $cond: [{ $eq: ['$$code', ''] }, fallback, '$$code'] } } });
const sums = { weightGram: { $sum: '$weightGram' }, salesAmountIdr: { $sum: '$salesAmountIdr' }, recordsWithoutWeight: { $sum: '$recordsWithoutWeight' } };
export function branchSalesPipeline(bySales: boolean, args: BranchSalesArgs): Document[] {
  const size = args.pageSize ?? 10, offset = ((args.page ?? 1) - 1) * size;
  const jenisSize = args.jenisPageSize ?? 10, jenisOffset = ((args.jenisPage ?? 1) - 1) * jenisSize;
  const pipeline: Document[] = [
    { $match: { ...validSalesMatch(), tgl_system: { $gte: args.from, $lte: args.to } } },
    { $project: { jenis: code('kode_dept', 'TANPA_JENIS'), salesCode: code('kode_sales', 'TANPA_SALES'), rawWeight: number('berat'), salesAmountIdr: number('harga_total') } },
    ...((args.jenisCode || args.salesCode) ? [{ $match: { ...(args.jenisCode ? { jenis: args.jenisCode } : {}), ...(args.salesCode ? { salesCode: args.salesCode } : {}) } }] : []),
    { $group: { _id: bySales ? { salesCode: '$salesCode', jenis: '$jenis' } : '$jenis', weightGram: { $sum: { $cond: [{ $gt: ['$rawWeight', 0] }, '$rawWeight', 0] } }, salesAmountIdr: { $sum: '$salesAmountIdr' }, recordsWithoutWeight: { $sum: { $cond: [{ $gt: ['$rawWeight', 0] }, 0, 1] } } } },
  ];
  if (bySales) pipeline.push(
    { $sort: { weightGram: -1, '_id.jenis': 1 } },
    { $group: { _id: '$_id.salesCode', ...sums, jenisCount: { $sum: 1 }, jenis: { $push: { kode: '$_id.jenis', weightGram: '$weightGram', salesAmountIdr: '$salesAmountIdr', recordsWithoutWeight: '$recordsWithoutWeight' } } } },
  );
  const rows: Document[] = [{ $sort: { weightGram: -1, _id: 1 } }, { $skip: offset }, { $limit: size }];
  if (bySales) rows.push(
    { $project: { weightGram: 1, salesAmountIdr: 1, recordsWithoutWeight: 1, jenisCount: 1, jenis: args.includeJenis === false ? { $literal: [] } : { $slice: ['$jenis', jenisOffset, jenisSize] } } },
    { $lookup: { from: 'tm_sales', let: { salesCode: '$_id' }, pipeline: [{ $match: { $expr: { $eq: [code('kode_sales', 'TANPA_SALES'), '$$salesCode'] } } }, { $project: { _id: 0, nama_sales: 1 } }, { $limit: 2 }], as: 'salesMaster' } },
  );
  pipeline.push({ $facet: { totals: [{ $group: { _id: null, ...sums, groupCount: { $sum: 1 } } }], rows: bySales || args.includeJenis ? rows : [{ $limit: 1 }, { $match: { _id: { $exists: false } } }] } });
  return pipeline;
}
function decodedName(value: unknown, fallback: string) {
  const name = decryptDepartmentName(value);
  return !name || typeof value === 'string' && /^(?:[a-f0-9]{2}){4,}$/i.test(value.trim()) && name === value.trim() ? { name: fallback, unavailable: true } : { name, unavailable: false };
}
function positiveInteger(value: unknown, fallback: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new BadRequestException(`${name} harus bilangan bulat 1–${max}.`);
  return value;
}
@Injectable()
export class BranchSalesService {
  constructor(private readonly mongo: MongoService) {}
  async read(bySales: boolean, input: BranchSalesArgs, allowed: AtomicSource[]) {
    atomicRange(input);
    if ((Date.parse(input.to) - Date.parse(input.from)) / 86400000 + 1 > 366) throw new BadRequestException('Laporan maksimum 366 hari.');
    for (const key of ['jenisCode', 'salesCode'] as const) if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key]!.trim() || input[key]!.length > 80)) throw new BadRequestException(`${key} tidak valid.`);
    if (input.includeJenis !== undefined && typeof input.includeJenis !== 'boolean') throw new BadRequestException('includeJenis harus boolean.');
    if (!bySales && input.salesCode !== undefined) throw new BadRequestException('Filter salesCode tersedia pada laporan per sales.');
    const args = { ...input, jenisCode: input.jenisCode?.trim(), salesCode: input.salesCode?.trim(), includeJenis: input.includeJenis ?? bySales, page: positiveInteger(input.page, 1, 100000, 'page'), pageSize: positiveInteger(input.pageSize, 10, 20, 'pageSize'), jenisPage: positiveInteger(input.jenisPage, 1, 100000, 'jenisPage'), jenisPageSize: positiveInteger(input.jenisPageSize, 10, 20, 'jenisPageSize') };
    const branches = allowed.filter(source => source.sourceType === 'branch');
    if (input.branchIds !== undefined && (!Array.isArray(input.branchIds) || !input.branchIds.length || input.branchIds.length > 100 || input.branchIds.some(id => typeof id !== 'string' || !branches.some(source => source.branchId === id)))) throw new BadRequestException('branchIds tidak tersedia atau tidak diizinkan.');
    const selected = branches.filter(source => !input.branchIds || input.branchIds.includes(source.branchId));
    if (!selected.length || selected.length > 100) throw new BadRequestException('Tidak ada cabang yang diizinkan atau jumlah cabang melewati batas.');
    const results: Document[] = [];
    for (let offset = 0; offset < selected.length; offset += 2) results.push(...await Promise.all(selected.slice(offset, offset + 2).map(async source => {
      try {
        const db = this.mongo.getDatabase(source.databaseName);
        if (!await db.listCollections({ name: 'tt_jual_detail' }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
        const [facet] = await db.collection('tt_jual_detail').aggregate(branchSalesPipeline(bySales, args), { maxTimeMS: 20000, allowDiskUse: true }).toArray();
        const totals = facet?.totals?.[0] ?? { weightGram: 0, salesAmountIdr: 0, recordsWithoutWeight: 0, groupCount: 0 };
        const rows: Document[] = facet?.rows ?? [];
        const jenisCodes = [...new Set(rows.flatMap(row => bySales ? (row.jenis ?? []).map((item: Document) => item.kode) : [row._id]))];
        const names = new Map<string, string>(), warnings: string[] = [];
        if (jenisCodes.length) try {
          const departments = await db.collection('tm_dept').find({ kode_dept: { $in: jenisCodes } }, { projection: { kode_dept: 1, nama_dept: 1 } }).limit(2000).maxTimeMS(5000).toArray();
          for (const department of departments) { const decoded = decodedName(department.nama_dept, String(department.kode_dept)); names.set(String(department.kode_dept), decoded.name); if (decoded.unavailable) warnings.push('Sebagian nama Jenis tidak dapat didekripsi.'); }
        } catch { warnings.push('Nama Jenis belum tersedia; kode tetap ditampilkan.'); }
        const fields = (row: Document) => ({ weightGram: row.weightGram, salesAmountIdr: row.salesAmountIdr, recordsWithoutWeight: row.recordsWithoutWeight });
        const items = rows.map(row => {
          if (!bySales) return { kode: String(row._id), nama: names.get(String(row._id)) ?? String(row._id), ...fields(row) };
          const master = row.salesMaster ?? [];
          const decoded = master.length === 1 && row._id !== 'TANPA_SALES' ? decodedName(master[0].nama_sales, `Sales ${row._id}`) : { name: row._id === 'TANPA_SALES' ? 'Sales tidak tercatat' : `Sales ${row._id}`, unavailable: true };
          if (decoded.unavailable) warnings.push('Sebagian nama sales tidak ditemukan, duplikat, atau tidak dapat didekripsi; kode sales ditampilkan.');
          return { salesCode: String(row._id), salesName: decoded.name, salesNameUnavailable: decoded.unavailable, ...fields(row), jenisCount: row.jenisCount, jenisPage: args.jenisPage, jenisPageSize: args.jenisPageSize, jenisHasMore: args.includeJenis && args.jenisPage * args.jenisPageSize < row.jenisCount, jenis: (row.jenis ?? []).map((item: Document) => ({ kode: item.kode, nama: names.get(item.kode) ?? item.kode, ...fields(item) })) };
        });
        return { branchId: source.branchId, alias: source.alias, status: 'available', totals: { weightGram: totals.weightGram, salesAmountIdr: totals.salesAmountIdr, recordsWithoutWeight: totals.recordsWithoutWeight }, groupCount: totals.groupCount, page: args.page, pageSize: args.pageSize, hasMore: (bySales || args.includeJenis) && args.page * args.pageSize < totals.groupCount, ...(bySales ? { salespeople: items } : { jenis: items }), warnings: [...new Set(warnings)] };
      } catch { return { branchId: source.branchId, alias: source.alias, status: 'unavailable', reason: 'Data penjualan tidak tersedia atau pembacaan melewati batas waktu; bukan penjualan nol.' }; }
    })));
    return { mode: bySales ? 'branch-salespeople' : 'branch-sales', period: { from: input.from, to: input.to, inclusive: true, timeZone: 'Asia/Jakarta', dateField: 'tgl_system' }, filters: { branchIds: selected.map(source => source.branchId), jenisCode: input.jenisCode, salesCode: input.salesCode, includeJenis: args.includeJenis }, policy: 'Penjualan status_kembali=OPEN, status_valid=DONE; status_tukar dan trs_barang_tukar true dikecualikan. Gram=sum(berat positif per baris), tidak dikalikan qty. Nilai=sum(harga_total). Total mencakup seluruh hasil filter, bukan halaman saja. Identitas sales scoped ke cabang: kode_sales → tm_sales.kode_sales → nama_sales didekripsi dengan ENC_KEY_DEC.', branches: results, partial: results.some(row => row.status !== 'available'), asOf: new Date().toISOString() };
  }
}
