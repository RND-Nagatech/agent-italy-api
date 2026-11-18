import { AgentDataSourceConfig, normalizeSourceType } from '../sources/source.types';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Document, MongoServerError, ObjectId } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { CacheManagementService } from '../cache/cache-management.service';
import { decryptDepartmentName } from '../common/department-name';

export type BaselineItem = { branchId: string; jenisCode: string; baselinePcs: number; active: boolean; note: string };
export type BaselineSnapshot = { revision: number; items: BaselineItem[]; updatedAt: Date | null };
export type BaselineMatrixUpdate = {
  receivedPairs: number;
  changedPairs: number;
  branchCount: number;
  jenisCount: number;
  validatedTotalRows: number;
  revision: number;
  updatedAt: Date | null;
};
type Change = { before: BaselineItem | null; after: BaselineItem };
type Audit = { revision: number; actorId: string; changedAt: Date; changes: Change[] };
interface BaselineDocument extends Document { _id: 'branch-stock-baselines'; revision: number; items: BaselineItem[]; updatedAt: Date; history: Audit[] }
export const EMPTY_BASELINES: BaselineSnapshot = { revision: 0, items: [], updatedAt: null };
export function baselineFor(snapshot: BaselineSnapshot, branchId: string, jenisCode: string) {
  const item = snapshot.items.find(row => row.branchId === branchId && row.jenisCode.toUpperCase() === jenisCode.toUpperCase());
  return { baselinePcs: item?.active ? item.baselinePcs : 0, baselineConfigured: Boolean(item?.active) };
}

@Injectable()
export class StockBaselineService {
  constructor(private readonly mongo: MongoService, private readonly cache: CacheManagementService) {}

  async snapshot(): Promise<BaselineSnapshot> {
    const doc = await this.collection.findOne({ _id: 'branch-stock-baselines' }, { projection: { revision: 1, items: 1, updatedAt: 1 } });
    return doc ? { revision: doc.revision, items: doc.items, updatedAt: doc.updatedAt } : { ...EMPTY_BASELINES, items: [] };
  }

  async get() {
    const [snapshot, catalog] = await Promise.all([this.snapshot(), this.catalog()]);
    return { ...snapshot, ...catalog };
  }

  async catalog() {
    // Legacy sources omit sourceType; match the default used by Sources and Agent.
    const sources = await this.mongo.db.collection<AgentDataSourceConfig>('shipment_sources').find(
      {},
      { projection: { branchId: 1, alias: 1, active: 1, sourceType: 1, databaseName: 1 } },
    ).toArray().then(rows => rows.map(source => ({ ...source, sourceType: normalizeSourceType(source.sourceType) })));
    const branches = sources.filter(source => source.sourceType === 'branch' && typeof source.branchId === 'string')
      .map(source => ({ branchId: String(source.branchId), alias: String(source.alias || source.branchId), active: source.active === true }))
      .sort((a, b) => a.branchId.localeCompare(b.branchId));
    const central = sources.find(source => source.sourceType === 'central' && source.active === true);
    const availableJenis: Array<{ kode: string; nama: string }> = [];
    let catalogWarning: string | null = null;
    if (central && typeof central.databaseName === 'string') {
      try {
        const docs = await this.mongo.getDatabase(central.databaseName).collection('tm_dept').find(
          { kode_dept: { $type: 'string', $ne: '' } }, { projection: { kode_dept: 1, nama_dept: 1 } },
        ).limit(1000).toArray();
        const unique = new Map<string, string>();
        for (const doc of docs) if (typeof doc.kode_dept === 'string') unique.set(doc.kode_dept.trim(), decryptDepartmentName(doc.nama_dept) ?? doc.kode_dept.trim());
        availableJenis.push(...[...unique].map(([kode, nama]) => ({ kode, nama })).sort((a, b) => a.kode.localeCompare(b.kode)));
      } catch { catalogWarning = 'Daftar Jenis Pusat gagal dibaca. Pengubahan patokan ditunda sampai sumber tersedia.'; }
    } else catalogWarning = 'Aktifkan sumber Pusat untuk membaca daftar Jenis.';
    return { branches, availableJenis, catalogWarning };
  }

  async update(revision: number, inputs: BaselineItem[], actorId: string) {
    if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 500) {
      throw new BadRequestException('Versi dan perubahan tidak valid. Maksimal 500 pasangan cabang/Jenis per penyimpanan.');
    }
    const [stored, catalog] = await Promise.all([this.collection.findOne({ _id: 'branch-stock-baselines' }), this.catalog()]);
    const current = stored ?? EMPTY_BASELINES;
    if (current.revision !== revision) throw new ConflictException('Patokan sudah diubah pengguna lain. Muat ulang sebelum menyimpan.');
    if (catalog.catalogWarning || !catalog.availableJenis.length) throw new BadRequestException(catalog.catalogWarning || 'Daftar Jenis belum tersedia.');
    const seen = new Set<string>(), existing = new Map(current.items.map(row => [key(row), row]));
    const changes: Change[] = [];
    for (const input of inputs) {
      if (!input || typeof input.branchId !== 'string' || typeof input.jenisCode !== 'string' || typeof input.active !== 'boolean'
        || !Number.isSafeInteger(input.baselinePcs) || input.baselinePcs < 0 || input.baselinePcs > 1_000_000
        || typeof input.note !== 'string' || input.note.length > 300) throw new BadRequestException('Patokan harus pcs bulat 0–1.000.000 dengan catatan maksimal 300 karakter.');
      const branch = catalog.branches.find(row => row.branchId === input.branchId.trim());
      const jenis = catalog.availableJenis.find(row => row.kode.toUpperCase() === input.jenisCode.trim().toUpperCase());
      if (!branch || !jenis) throw new BadRequestException('Kode cabang atau Jenis tidak ditemukan pada master.');
      const next: BaselineItem = { branchId: branch.branchId, jenisCode: jenis.kode, baselinePcs: input.baselinePcs, active: input.active, note: input.note.trim() };
      const id = key(next);
      if (seen.has(id)) throw new BadRequestException(`Pasangan ${next.branchId}/${next.jenisCode} muncul lebih dari sekali.`);
      seen.add(id);
      const before = existing.get(id) ?? null;
      if (!branch.active && !before) throw new BadRequestException('Patokan baru hanya boleh dibuat untuk sumber cabang aktif.');
      if (JSON.stringify(before) !== JSON.stringify(next)) { changes.push({ before, after: next }); existing.set(id, next); }
    }
    if (!changes.length) return this.get();
    if (existing.size > 5000) throw new BadRequestException('Maksimal 5.000 pasangan patokan dapat disimpan.');
    const updatedAt = new Date();
    try {
      const result = await this.collection.findOneAndUpdate(
        { _id: 'branch-stock-baselines', revision },
        { $set: { revision: revision + 1, updatedAt, items: [...existing.values()].sort((a, b) => key(a).localeCompare(key(b))),
          history: [...(stored?.history ?? []), { revision: revision + 1, actorId, changedAt: updatedAt, changes }].slice(-20) } },
        { upsert: revision === 0, returnDocument: 'after' },
      );
      if (!result) throw new ConflictException('Patokan berubah saat disimpan. Muat ulang dan coba lagi.');
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) throw new ConflictException('Patokan berubah saat disimpan. Muat ulang dan coba lagi.');
      throw error;
    }
    this.cache.clearByPrefix('agent:restock:');
    this.cache.clearByPrefix('agent:network-restock:');
    return this.get();
  }

  async updateFromChatMatrix(text: string, actorId: string): Promise<BaselineMatrixUpdate> {
    const [snapshot, catalog] = await Promise.all([this.snapshot(), this.catalog()]);
    if (catalog.catalogWarning || !catalog.availableJenis.length) throw new BadRequestException(catalog.catalogWarning || 'Daftar Jenis belum tersedia.');
    const matrix = parseChatBaselineMatrix(text, catalog);
    const currentByKey = new Map(snapshot.items.map(item => [key(item), item]));
    const updates = matrix.items.map(item => {
      const current = currentByKey.get(key(item));
      return { ...item, active: true, note: current?.note ?? '' };
    });
    const changedPairs = updates.filter(item => JSON.stringify(currentByKey.get(key(item)) ?? null) !== JSON.stringify(item)).length;
    const saved = await this.update(snapshot.revision, updates, actorId);
    return {
      receivedPairs: updates.length,
      changedPairs,
      branchCount: new Set(updates.map(item => item.branchId)).size,
      jenisCount: new Set(updates.map(item => item.jenisCode)).size,
      validatedTotalRows: matrix.validatedTotalRows,
      revision: saved.revision,
      updatedAt: saved.updatedAt,
    };
  }

  async history() {
    const doc = await this.collection.findOne({ _id: 'branch-stock-baselines' }, { projection: { history: 1 } });
    const history = [...(doc?.history ?? [])].reverse();
    const ids = [...new Set(history.map(row => row.actorId))].filter(ObjectId.isValid).map(id => new ObjectId(id));
    const users = ids.length ? await this.mongo.db.collection('users').find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray() : [];
    const names = new Map(users.map(user => [String(user._id), typeof user.name === 'string' ? user.name : 'Pengguna']));
    return { items: history.map(row => ({ ...row, actorName: names.get(row.actorId) ?? 'Pengguna' })) };
  }

  private get collection() { return this.mongo.db.collection<BaselineDocument>('app_settings'); }
}
function key(row: Pick<BaselineItem, 'branchId' | 'jenisCode'>) { return JSON.stringify([row.branchId, row.jenisCode]); }

const MAX_CHAT_BASELINE_MATRIX_CHARACTERS = 20_000;

function parseChatBaselineMatrix(text: string, catalog: Awaited<ReturnType<StockBaselineService['catalog']>>) {
  if (typeof text !== 'string' || text.length > MAX_CHAT_BASELINE_MATRIX_CHARACTERS) {
    throw new BadRequestException(`Tabel patokan stok wajib berukuran maksimal ${MAX_CHAT_BASELINE_MATRIX_CHARACTERS.toLocaleString('id-ID')} karakter.`);
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const parseCells = (line: string) => {
    let cells: string[];
    if (line.includes('\t')) cells = line.split('\t');
    else if (line.includes('|')) {
      cells = line.split('|');
      if (cells[0]?.trim() === '') cells.shift();
      if (cells.at(-1)?.trim() === '') cells.pop();
    } else cells = [line];
    return cells.map(cell => cell.trim());
  };
  const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const headerIndex = lines.findIndex(line => normalize(parseCells(line).find(cell => cell.trim()) ?? '') === 'KODEJENIS');
  if (headerIndex < 0) throw new BadRequestException('Header matriks tidak ditemukan. Gunakan baris pertama dengan kolom “KODE JENIS”, lalu satu kolom per kode cabang.');

  const headerCells = parseCells(lines[headerIndex]);
  while (headerCells[0] === '') headerCells.shift();
  while (headerCells.at(-1) === '') headerCells.pop();
  const rawBranchHeaders = headerCells.slice(1);
  if (!rawBranchHeaders.length || rawBranchHeaders.some(header => !header)) {
    throw new BadRequestException('Setiap kolom setelah “KODE JENIS” harus memiliki kode cabang atau alias yang jelas.');
  }
  const branchIds = rawBranchHeaders.map(rawHeader => {
    const exact = catalog.branches.filter(branch => branch.branchId.trim().toUpperCase() === rawHeader.toUpperCase());
    const normalizedHeader = normalize(rawHeader.replace(/^PANTES\s+/i, ''));
    const aliases = catalog.branches.filter(branch => normalize(branch.alias.replace(/^PANTES\s+/i, '')) === normalizedHeader);
    const matches = exact.length ? exact : aliases;
    if (matches.length !== 1) throw new BadRequestException(`Kolom cabang “${rawHeader}” tidak dikenal atau aliasnya ambigu. Gunakan Branch ID/alias dari menu Sumber data.`);
    return matches[0].branchId;
  });
  if (new Set(branchIds).size !== branchIds.length) throw new BadRequestException('Ada kode cabang yang sama lebih dari sekali pada header tabel.');
  if (branchIds.length > 100) throw new BadRequestException('Matriks maksimal memuat 100 kolom cabang.');

  const items: BaselineItem[] = [];
  const seen = new Set<string>();
  let sectionTotals = Array<number>(branchIds.length).fill(0);
  let sectionRows = 0;
  let validatedTotalRows = 0;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const cells = parseCells(line);
    if (cells.every(cell => !cell)) continue;
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const marker = normalize(cells[0] ?? '');
    if (marker === 'KODEJENIS') continue;
    if (marker === 'TOTAL') {
      if (cells.length !== branchIds.length + 1) throw new BadRequestException(`Baris ${index + 1}: jumlah kolom TOTAL tidak cocok dengan header.`);
      if (!sectionRows) throw new BadRequestException(`Baris ${index + 1}: TOTAL tidak memiliki baris Jenis yang bisa dijumlahkan.`);
      for (let branchIndex = 0; branchIndex < branchIds.length; branchIndex += 1) {
        const total = parseBaselinePcs(cells[branchIndex + 1], index + 1, catalog.branches.find(row => row.branchId === branchIds[branchIndex])?.alias ?? branchIds[branchIndex]);
        if (total !== sectionTotals[branchIndex]) {
          const alias = catalog.branches.find(row => row.branchId === branchIds[branchIndex])?.alias ?? branchIds[branchIndex];
          throw new BadRequestException(`Baris ${index + 1}: TOTAL ${alias} adalah ${total.toLocaleString('id-ID')}, tetapi jumlah baris di atasnya ${sectionTotals[branchIndex].toLocaleString('id-ID')}. Tabel tidak disimpan.`);
        }
      }
      validatedTotalRows += 1;
      sectionTotals = Array<number>(branchIds.length).fill(0);
      sectionRows = 0;
      continue;
    }

    const jenis = catalog.availableJenis.find(row => row.kode.trim().toUpperCase() === (cells[0] ?? '').trim().toUpperCase());
    if (!jenis) {
      if (!/^[A-Z0-9_-]{1,16}$/i.test(cells[0] ?? '')) break;
      throw new BadRequestException(`Baris ${index + 1}: kode Jenis “${cells[0]}” tidak ada pada master Pusat.`);
    }
    if (cells.length !== branchIds.length + 1) throw new BadRequestException(`Baris ${index + 1}: jumlah nilai tidak cocok dengan jumlah cabang pada header.`);
    for (let branchIndex = 0; branchIndex < branchIds.length; branchIndex += 1) {
      const baselinePcs = parseBaselinePcs(cells[branchIndex + 1], index + 1, catalog.branches.find(row => row.branchId === branchIds[branchIndex])?.alias ?? branchIds[branchIndex]);
      const item = { branchId: branchIds[branchIndex], jenisCode: jenis.kode, baselinePcs, active: true, note: '' };
      const itemKey = key(item);
      if (seen.has(itemKey)) throw new BadRequestException(`Baris ${index + 1}: pasangan ${item.branchId}/${item.jenisCode} muncul lebih dari sekali.`);
      seen.add(itemKey);
      items.push(item);
      sectionTotals[branchIndex] += baselinePcs;
    }
    sectionRows += 1;
    if (items.length > 500) throw new BadRequestException('Matriks melampaui batas 500 pasangan cabang/Jenis per penyimpanan.');
  }

  if (!items.length) throw new BadRequestException('Tidak ada baris Jenis yang dapat dibaca. Tempel matriks dengan kolom “KODE JENIS” dan angka pcs bulat.');
  return { items, validatedTotalRows };
}

function parseBaselinePcs(value: string | undefined, lineNumber: number, branchLabel: string) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new BadRequestException(`Baris ${lineNumber}: patokan ${branchLabel} harus berupa angka pcs bulat tanpa pemisah ribuan.`);
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount > 1_000_000) {
    throw new BadRequestException(`Baris ${lineNumber}: patokan ${branchLabel} harus berada pada rentang 0–1.000.000 pcs.`);
  }
  return amount;
}
