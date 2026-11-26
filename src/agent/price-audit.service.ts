import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import type { Db, Document } from 'mongodb';
import { MongoService } from '../database/mongo.service';
import { validSalesMatch } from '../sales/sales-query-policy';
import { decryptBankField } from './banking.logic';
import { PriceReferenceService } from './price-reference.service';
import { auditPriceTransaction, validatePriceWindows, type AuditTransaction, type PriceAuditRow } from './price-audit.logic';
import { PriceAuditDto } from './dto/price-audit.dto';
import type { AgentResponseBlock } from './response-blocks';
import type { TransactionReportSource } from './transaction-report.service';
import { auditBuybackTransaction, auditBuybackBatches, buybackCode, BUYBACK_STATUSES, type BuybackTransaction, type BuybackAuditRow } from './buyback-audit.logic';
import { auditSalesCodeBatches } from './sales-code-audit.logic';
import { auditMarketplacePrice, marketplacePriceReportTable, marketplaceStatusLabel } from './marketplace-price-audit.logic';
import { buybackReportTable } from './buyback-report.logic';
import { headerSchedule, priceReferenceParts } from './price-reference-periods';
import { LegacyBarangService, type LegacyBarangLookup, type LegacyBarangMatch } from '../database/legacy-barang.service';
import { invoiceAuthorization, readAboveNoteBuybackAuthorizations, readBelowCostAuthorizations } from './marketplace-authorization';
import { auditBullionBuyback, BULLION_GROUPS, bullionBuybackReportTable, type BullionAuditRow, type BullionTransaction } from './bullion-buyback.logic';
import { auditBullionMarketplace, bullionMarketplaceReportTable, type BullionMarketplaceRow } from './bullion-marketplace.logic';

const number = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = decryptBankField(value);
  if (!text || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text); return Number.isFinite(n) ? n : null;
};

export function priceAuditTransaction(row: Document, kind: 'sales' | 'buyback', store: string): AuditTransaction {
  const embedded = row.barang;
  let kadar: number | null;
  let kadarSource = 'Detail transaksi';
  if (Array.isArray(embedded) && embedded.length) {
    const values = embedded.map(item => { const value = number(item?.kadar); return value !== null && value > 0 ? value : null; });
    const unique = new Set(values);
    kadar = unique.size === 1 && values.every(value => value !== null) ? values[0] : null;
    if (kadar === null && values.some(value => value !== null)) kadarSource = 'Snapshot barang ambigu';
  } else {
    kadar = embedded?.kadar !== undefined && embedded.kadar !== null ? number(embedded.kadar) : kind === 'buyback' ? number(row.kadar) : null;
    if (kadar !== null && kadar <= 0) kadar = null;
  }
  if (kadar === null && kadarSource !== 'Snapshot barang ambigu') kadarSource = 'Belum tersedia';
  return {
    id: String(row._id), kind, store, date: String(row.tgl_system ?? ''), time: decryptBankField(row.jam),
    invoice: String((kind === 'sales' ? row.no_faktur_jual : row.no_faktur_beli) ?? ''),
    name: decryptBankField(row.nama_barang), kadar,
    barcode: decryptBankField(row.kode_barcode), kadarSource,
    ...(kadarSource === 'Snapshot barang ambigu' ? { kadarNote: 'Snapshot barang pada detail transaksi memuat kadar yang berbeda/belum lengkap. Kadar master tidak dipakai untuk mengganti snapshot yang ambigu.' } : {}),
    weight: number(row.berat), price: number(kind === 'sales' ? row.harga_jual : row.harga), pricePerGram: number(kind === 'sales' ? row.harga_gram : row.harga_rata), fee: number(row.ongkos),
    ...(kind === 'buyback' ? { invoicePrice: number(row.harga_nota) } : {}),
    ...(kind === 'sales' ? { marketplace: decryptBankField(row.kode_marketplace), invoiceGroup: decryptBankField(row.no_faktur_group_user), overpayment: number(row.lebih_bayar) } : {}),
    quantity: kind === 'sales' ? number(row.qty) ?? 1 : 1,
    condition: [decryptBankField(row.kondisi), decryptBankField(row.tipe_kondisi)].filter(Boolean).join(' '), inputBy: decryptBankField(row.input_by),
  };
}

export function priceAuditDetails(row: Document, kind: 'sales' | 'buyback', includeBullion = false): Document[] {
  if (kind === 'buyback' && row.status_valid === 'CANC') return [];
  if (!Array.isArray(row.detail_barang)) return [row];
  return row.detail_barang.flatMap((detail: unknown, index: number) => {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return [];
    const item = detail as Document;
    if (kind === 'sales' ? item.status_valid !== undefined && item.status_valid !== 'DONE' : item.status_valid === 'CANC') return [];
    if (kind === 'sales' && ((item.status_kembali !== undefined && item.status_kembali !== 'OPEN') || item.status_tukar === true || item.trs_barang_tukar === true)) return [];
    if (!includeBullion && (/^LM/i.test(String(item.kode_dept ?? '')) || BULLION_GROUPS.includes(item.kode_group))) return [];
    if (['LAINNYA', 'PACKING', 'PLASTIK'].includes(String(item.kode_dept ?? '')) || item.kode_group === 'ACC') return [];
    // Item prices and identity must never be inherited from a grouped header.
    // lebih_bayar remains group-level metadata; detail values take precedence.
    const { detail_barang: _details, barang: _barang, kadar: _kadar, kode_barcode: _barcode, berat: _berat, harga_jual: _sale, harga: _purchase, harga_nota: _invoice, harga_gram: _perGram, harga_rata: _average, kode_intern: _internal, kadar_cetak: _printed, kondisi: _condition, tipe_kondisi: _conditionType, ongkos: _fee, qty: _qty, ...header } = row;
    return [{ ...header, ...detail, _id: `${String(row._id)}:${index}` }];
  });
}

export function buybackAuditTransaction(row: Document, store: string): BuybackTransaction {
  return { ...priceAuditTransaction(row, 'buyback', store), barcode: typeof row.kode_barcode === 'number' ? String(row.kode_barcode) : decryptBankField(row.kode_barcode), condition: decryptBankField(row.kondisi), internalCode: '-', printedKadar: decryptBankField(row.kadar_cetak) };
}

type BuybackMaster = { internalCode: string; printedKadar: string; kadar: number | null; note?: string; missing?: boolean; source?: 'MongoDB' };
export async function fillPriceMaster(items: Array<{ record: Document; tx: AuditTransaction }>, db: Db, cache: Map<string, BuybackMaster>, legacy?: LegacyBarangLookup, legacyCache = new Map<string, LegacyBarangMatch>()) {
  const barcodes = new Map<string, string | number>();
  for (const { record, tx } of items) {
    const raw = record.kode_barcode;
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !String(raw).trim() || raw === '-') {
      tx.lookupNote = 'Barcode transaksi tidak tersedia; kode internal barang tidak diketahui.'; continue;
    }
    if (!cache.has(barcodeKey(raw))) barcodes.set(barcodeKey(raw), raw);
  }
  if (barcodes.size) {
    try {
      const limit = barcodes.size * 2 + 1;
      const matches = await db.collection('tm_barang').find({ kode_barcode: { $in: [...barcodes.values()] } }, { projection: { _id: 0, kode_barcode: 1, kode_intern: 1, kadar_cetak: 1, kadar: 1 } }).maxTimeMS(5000).limit(limit).toArray();
      for (const [key] of barcodes) {
        const found = matches.filter(row => (typeof row.kode_barcode === 'string' || typeof row.kode_barcode === 'number') && barcodeKey(row.kode_barcode) === key);
        const internalCode = found.length === 1 ? decryptBankField(found[0].kode_intern) : '';
        const note = matches.length >= limit ? 'Hasil lookup barcode terlalu banyak; kode internal belum dapat dipastikan.'
          : !found.length ? 'Barang dengan barcode ini tidak ditemukan di tm_barang; kode internal tidak diketahui.'
          : found.length > 1 ? 'Barcode ditemukan pada beberapa barang; kode internal tidak dipilih dengan menebak.'
          : !buybackCode(internalCode) ? 'Kode internal pada master barang kosong atau belum dapat didekripsi/dibaca.' : undefined;
        cache.set(key, { internalCode: note ? '-' : internalCode, printedKadar: found.length === 1 ? decryptBankField(found[0].kadar_cetak) : '', kadar: found.length === 1 ? number(found[0].kadar) : null, note,
          missing: !found.length && matches.length < limit, ...(found.length === 1 ? { source: 'MongoDB' as const } : {}) });
      }
    } catch {
      for (const [key] of barcodes) cache.set(key, { internalCode: '-', printedKadar: '', kadar: null, note: 'Lookup master barang belum dapat dibaca; kode internal belum diketahui.' });
    }
  }
  for (const { record, tx } of items) {
    const raw = record.kode_barcode;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const found = cache.get(barcodeKey(raw));
    if (!found) continue;
    tx.internalCode = found.internalCode; tx.printedKadar ||= found.printedKadar; tx.lookupNote = found.note; tx.masterSource = found.source;
    if (tx.kind === 'sales' && tx.kadar === null && tx.kadarSource !== 'Snapshot barang ambigu' && !found.note && found.kadar !== null && found.kadar > 0) {
      tx.kadar = found.kadar; tx.kadarSource = 'Master barang (barcode)';
    }
  }
  if (legacy) {
    const missing = items.filter(({ record, tx }) => tx.kind === 'buyback' && (typeof record.kode_barcode === 'string' || typeof record.kode_barcode === 'number') && cache.get(barcodeKey(record.kode_barcode))?.missing);
    const pending = [...new Set(missing.map(({ record }) => String(record.kode_barcode)))].filter(barcode => !legacyCache.has(barcode));
    if (pending.length) {
      try {
        const results = await legacy.lookupMany(pending);
        for (const barcode of pending) legacyCache.set(barcode, results.get(barcode) ?? { status: 'unavailable' });
      } catch { for (const barcode of pending) legacyCache.set(barcode, { status: 'unavailable' }); }
    }
    for (const { record, tx } of missing) {
      const match = legacyCache.get(String(record.kode_barcode));
      if (!match) continue;
      if (match.status === 'found') { tx.internalCode = match.internalCode; tx.lookupNote = undefined; tx.masterSource = 'MariaDB (RDS)'; continue; }
      tx.lookupNote = match.status === 'not-found' ? 'Kode intern barang belum diketahui.'
        : match.status === 'ambiguous' ? 'Barcode ditemukan pada beberapa data barang; kode intern belum dapat dipastikan.'
          : match.status === 'unreadable' ? 'Kode intern barang lama kosong atau belum dapat dibaca.'
            : match.status === 'disabled' ? 'Pencarian data barang lama belum tersedia; kode intern belum diketahui.'
              : 'Data barang lama belum dapat diperiksa; kode intern belum diketahui.';
    }
  }
}
export const fillBuybackMaster = fillPriceMaster;

type KadarMatch = { kadar: number | null; note?: string };
type PreparedSale = { record: Document; tx: AuditTransaction };
const barcodeKey = (value: string | number) => `${typeof value}:${String(value)}`;

export async function fillMissingSaleKadar(items: PreparedSale[], db: Db, cache: Map<string, KadarMatch>) {
  const missing = items.filter(({ tx }) => tx.kadar === null && tx.kadarSource !== 'Snapshot barang ambigu');
  const barcodes = new Map<string, string | number>();
  for (const { record, tx } of missing) {
    const raw = record.kode_barcode;
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !String(raw).trim()) {
      tx.kadarNote = 'Kadar pada transaksi belum tersedia dan barcode tidak tercatat untuk mencari barang.'; continue;
    }
    const key = barcodeKey(raw);
    if (!cache.has(key)) barcodes.set(key, raw);
  }
  if (barcodes.size) {
    try {
      // Batch only missing snapshot grades, in the same source database. The
      // stored barcode is copied unchanged between transaction and master.
      const limit = barcodes.size * 2 + 1;
      const matches = await db.collection('tm_barang').find({ kode_barcode: { $in: [...barcodes.values()] } }, { projection: { _id: 0, kode_barcode: 1, kadar: 1 } }).maxTimeMS(5000).limit(limit).toArray();
      for (const [key] of barcodes) {
        const found = matches.filter(row => (typeof row.kode_barcode === 'string' || typeof row.kode_barcode === 'number') && barcodeKey(row.kode_barcode) === key);
        const value = found.length === 1 ? number(found[0].kadar) : null;
        cache.set(key, matches.length >= limit
          ? { kadar: null, note: 'Hasil pencarian barcode terlalu banyak; kadar master belum dapat dipastikan.' }
          : found.length > 1 ? { kadar: null, note: 'Barcode ditemukan pada beberapa barang; kadar tidak dipilih dengan menebak.' }
            : value !== null && value > 0 ? { kadar: value }
              : { kadar: null, note: 'Kadar pada transaksi belum tersedia; barang dengan barcode tersebut tidak ditemukan atau kadar master belum valid.' });
      }
    } catch {
      for (const [key] of barcodes) cache.set(key, { kadar: null, note: 'Kadar transaksi belum tersedia dan pencarian master barang belum dapat dibaca.' });
    }
  }
  for (const { record, tx } of missing) {
    const raw = record.kode_barcode;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const match = cache.get(barcodeKey(raw));
    if (match?.kadar !== null && match?.kadar !== undefined) { tx.kadar = match.kadar; tx.kadarSource = 'Master barang (barcode)'; }
    else tx.kadarNote ||= match?.note;
  }
}

@Injectable()
export class PriceAuditService {
  constructor(private readonly mongo: MongoService, private readonly references: PriceReferenceService, @Optional() private readonly legacy?: LegacyBarangService) { }

  async report(dto: PriceAuditDto, sources: TransactionReportSource[], ownerId: string, sessionId: string) {
    const invalid = validatePriceWindows(dto.windows);
    if (invalid) throw new BadRequestException(invalid);
    if (!sources.length) throw new BadRequestException('Belum ada toko terdaftar yang dapat diperiksa.');
    const references = await this.references.read(sessionId, ownerId, [...new Set(dto.windows.flatMap(w => w.attachmentIds))]);
    const hasSales = references.some(ref => ref.rows.some(rule => rule.kind === 'sales' && rule.family !== 'bullion'));
    const hasBullionSales = references.some(ref => ref.rows.some(rule => rule.kind === 'sales' && rule.family === 'bullion'));
    const hasBuyback = references.some(ref => ref.rows.some(rule => rule.kind === 'buyback' && rule.family !== 'bullion'));
    const hasBullion = references.some(ref => ref.rows.some(rule => rule.kind === 'buyback' && rule.family === 'bullion'));
    const jewelryReferences = priceReferenceParts(references).map(ref => ({ ...ref, rows: ref.rows.filter(rule => rule.family !== 'bullion') })).filter(ref => ref.rows.length);
    const autoBatch = hasBuyback && (dto.buybackAutoBatch === true || jewelryReferences.some(ref => ref.effectiveFrom && ref.rows.some(row => row.kind === 'buyback')));
    const autoSales = hasSales && (dto.salesAutoBatch === true || dto.salesMarketplaceOnly === true);
    const marketplaceOnly = (hasSales || hasBullionSales) && dto.salesMarketplaceOnly === true;
    if (!hasSales && !hasBuyback && !hasBullion && !hasBullionSales) throw new BadRequestException('Tidak ada tarif penjualan/buyback yang dapat diperiksa.');
    const edited = new Set<string>();
    for (const override of dto.kadarOverrides ?? []) {
      const reference = references.find(ref => ref.id === override.referenceId);
      const key = `${override.referenceId}:${override.rowIndex}`;
      if (!reference?.rows[override.rowIndex] || reference.rows[override.rowIndex].kind !== 'sales' || edited.has(key)) throw new BadRequestException('Pemetaan kadar acuan penjualan tidak valid atau berulang.');
      edited.add(key);
      reference.rows[override.rowIndex] = { ...reference.rows[override.rowIndex], kadar: override.kadar };
    }
    for (const window of dto.windows) for (const id of window.attachmentIds) {
      const ref = references.find(item => item.id === id)!;
      if (!ref.date || ref.date !== window.date) throw new BadRequestException(`Tanggal file ${ref.filename} (${ref.date || 'belum terbaca'}) berbeda dari acuan ${window.date}. Perbaiki tanggal/file sebelum memeriksa.`);
    }
    const dates = [...new Set(dto.windows.map(w => w.date))];
    const rows: PriceAuditRow[] = [];
    const buybackRows: BuybackAuditRow[] = [];
    const bullionRows: BullionAuditRow[] = [];
    const bullionSalesRows: BullionMarketplaceRow[] = [];
    const warnings: string[] = [];
    const usedSources: Array<{ alias: string; branchId: string }> = [];
    let scanned = 0;
    const legacyCache = new Map<string, LegacyBarangMatch>();
    for (const source of sources) {
      let available = false;
      const kadarCache = new Map<string, KadarMatch>();
      const masterCache = new Map<string, BuybackMaster>();
      for (const kind of hasSales ? ['sales'] as const : []) {
        const collection = 'tt_jual_detail';
        const db = this.mongo.getDatabase(source.databaseName);
        const sourceRows: PriceAuditRow[] = [];
        try {
          if (!await db.listCollections({ name: collection }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
          const marketplaceMatch = { $exists: true, $nin: ['-', '', null] };
          const query = { ...validSalesMatch(), tgl_system: { $in: dates }, kode_dept: { $not: /^LM/i, $nin: ['LAINNYA', 'PACKING', 'PLASTIK'] }, kode_group: { $ne: 'ACC', $nin: [...BULLION_GROUPS] },
            ...(marketplaceOnly ? { $or: [{ kode_marketplace: marketplaceMatch }, { 'detail_barang.kode_marketplace': marketplaceMatch }] } : {}) };
          const fields = ['_id', 'tgl_system', 'jam', 'no_faktur_jual', 'no_faktur_group_user', 'kode_marketplace', 'nama_barang', 'kode_barcode', 'barang.kadar', 'kadar', 'kadar_cetak', 'berat', 'harga_jual', 'harga_gram', 'ongkos', 'lebih_bayar', 'qty', 'input_by', 'status_valid', 'status_kembali', 'status_tukar', 'trs_barang_tukar', 'kode_dept', 'kode_group'];
          const projection = Object.fromEntries(fields.flatMap(field => [[field, 1], [`detail_barang.${field}`, 1]]));
          const cursor = db.collection(collection).find(query, { projection }).maxTimeMS(20000).batchSize(500);
          try {
            const batch: Document[] = [];
            const flush = async () => {
              const items: PreparedSale[] = [];
              for (const document of batch.splice(0)) {
                for (const record of priceAuditDetails(document, kind)) {
                  if (marketplaceOnly && (record.status_valid !== 'DONE' || record.status_kembali !== 'OPEN' || record.status_tukar === true || record.trs_barang_tukar === true)) continue;
                  if (++scanned > 25000) throw new BadRequestException('Lebih dari 25.000 transaksi pada tanggal pilihan. Kurangi tanggal agar seluruh data dapat diperiksa; hasil tidak dipotong.');
                  const tx = priceAuditTransaction(record, kind, source.alias);
                  if (marketplaceOnly && (!tx.marketplace || ['-', 'ALL', 'SEMUA'].includes(tx.marketplace.toUpperCase()) || /\b(?:packing|plastik\s*bening)\b/i.test(tx.name))) continue;
                  if (autoSales && !marketplaceOnly) { tx.internalCode = '-'; tx.printedKadar = decryptBankField(record.kadar_cetak); }
                  if (/\b(?:antam|perak|silver|bullion|logam\s+mulia)\b/i.test(tx.name)) continue;
                  if (autoSales || marketplaceOnly) {
                    if (!references.some(ref => ref.date === tx.date && ref.rows.some(rule => rule.kind === 'sales'))) continue;
                  } else {
                    const dayWindows = dto.windows.filter(w => w.date === tx.date);
                    const window = dayWindows.find(w => /^\d{2}:\d{2}:\d{2}$/.test(tx.time) && tx.time.slice(0, 5) >= w.fromTime && tx.time.slice(0, 5) < w.toTime);
                    if (!window && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time)) continue;
                    if (window && !references.some(ref => window.attachmentIds.includes(ref.id) && ref.rows.some(rule => rule.kind === 'sales'))) continue;
                  }
                  items.push({ record, tx });
                }
              }
              if (autoSales && !marketplaceOnly) await fillPriceMaster(items, db, masterCache);
              else await fillMissingSaleKadar(items, db, kadarCache);
              if (marketplaceOnly) {
                const authorizations = await readBelowCostAuthorizations(db, items.map(({ tx }) => tx.invoice));
                for (const { tx } of items) tx.belowCostAuthorization = invoiceAuthorization([tx.invoice], authorizations);
              }
              for (const { tx } of items) {
                if (marketplaceOnly) { sourceRows.push(auditMarketplacePrice(tx, references, dto.toleranceRp ?? 0)); continue; }
                if (autoSales) { sourceRows.push(auditSalesCodeBatches(tx, references, dto.toleranceRp ?? 0)); continue; }
                const window = dto.windows.find(w => w.date === tx.date && /^\d{2}:\d{2}:\d{2}$/.test(tx.time) && tx.time.slice(0, 5) >= w.fromTime && tx.time.slice(0, 5) < w.toTime);
                const selected = window ? references.filter(ref => window.attachmentIds.includes(ref.id)) : [];
                const result = auditPriceTransaction(tx, window, selected, dto.toleranceRp ?? 0);
                sourceRows.push(result);
              }
            };
            for await (const document of cursor) {
              batch.push(document);
              if (batch.length >= 200) await flush();
            }
            if (batch.length) await flush();
          } finally { await cursor.close(); }
          rows.push(...sourceRows); available = true;
        } catch (error) {
          if (error instanceof BadRequestException) throw error;
          warnings.push(`${source.alias}: penjualan gagal dibaca. Hasil tidak dianggap lengkap.`);
        }
      }
      if (hasBullionSales) {
        const db=this.mongo.getDatabase(source.databaseName),sourceRows:BullionMarketplaceRow[]=[];
        try {
          if(!await db.listCollections({name:'tt_jual_detail'},{nameOnly:true}).hasNext())throw new Error('missing collection');
          const marketplaceMatch={$exists:true,$nin:['-','',null]};
          const query={...validSalesMatch(),tgl_system:{$in:dates},$and:[{$or:[{kode_group:{$in:[...BULLION_GROUPS]}},{'detail_barang.kode_group':{$in:[...BULLION_GROUPS]}}]},{$or:[{kode_marketplace:marketplaceMatch},{'detail_barang.kode_marketplace':marketplaceMatch}]}]};
          const fields=['_id','tgl_system','jam','no_faktur_jual','no_faktur_group_user','kode_marketplace','kode_barcode','nama_barang','kode_group','kode_dept','berat','harga_jual','harga_gram','ongkos','lebih_bayar','qty','input_by','status_valid','status_kembali','status_tukar','trs_barang_tukar'];
          const projection=Object.fromEntries(fields.flatMap(field=>[[field,1],[`detail_barang.${field}`,1]]));
          const cursor=db.collection('tt_jual_detail').find(query,{projection}).maxTimeMS(20000).batchSize(500),batch:Document[]=[];
          const flush=async()=>{
            const items:BullionTransaction[]=[];
            for(const document of batch.splice(0))for(const record of priceAuditDetails(document,'sales',true)){
              if(!BULLION_GROUPS.includes(record.kode_group)||record.status_valid!=='DONE'||record.status_kembali!=='OPEN'||record.status_tukar===true||record.trs_barang_tukar===true)continue;
              if(++scanned>25000)throw new BadRequestException('Lebih dari 25.000 transaksi pada tanggal pilihan. Kurangi tanggal agar seluruh data dapat diperiksa; hasil tidak dipotong.');
              const tx={...priceAuditTransaction(record,'sales',source.alias),group:String(record.kode_group)};
              if(!tx.marketplace||['-','ALL','SEMUA'].includes(tx.marketplace.toUpperCase())||/\b(?:perak|silver|packing|plastik\s*bening)\b/i.test(tx.name))continue;
              if(!references.some(ref=>ref.date===tx.date&&ref.rows.some(rule=>rule.family==='bullion'&&rule.kind==='sales')))continue;
              items.push(tx);
            }
            const authorizations=await readBelowCostAuthorizations(db,items.map(tx=>tx.invoice));
            for(const tx of items){tx.belowCostAuthorization=invoiceAuthorization([tx.invoice],authorizations);sourceRows.push(auditBullionMarketplace(tx,references,'per-gram',dto.toleranceRp??0));}
          };
          try{for await(const document of cursor){batch.push(document);if(batch.length>=200)await flush();}if(batch.length)await flush();}finally{await cursor.close();}
          bullionSalesRows.push(...sourceRows);available=true;
        }catch(error){if(error instanceof BadRequestException)throw error;warnings.push(`${source.alias}: penjualan marketplace logam mulia gagal dibaca. Hasil tidak dianggap lengkap.`);}
      }
      if (hasBuyback) {
        const db = this.mongo.getDatabase(source.databaseName);
        const cache = masterCache;
        const sourceRows: BuybackAuditRow[] = [];
        try {
          if (!await db.listCollections({ name: 'tt_beli_detail' }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
          const query = { tgl_system: { $in: dates }, status_valid: { $ne: 'CANC' }, kode_dept: { $not: /^LM/i, $nin: ['LAINNYA', 'PACKING', 'PLASTIK'] }, kode_group: { $ne: 'ACC', $nin: [...BULLION_GROUPS] } };
          const fields = ['_id', 'tgl_system', 'jam', 'no_faktur_beli', 'nama_barang', 'kode_barcode', 'kadar', 'kadar_cetak', 'berat', 'harga', 'harga_nota', 'harga_rata', 'kondisi', 'input_by', 'status_valid', 'kode_dept', 'kode_group'];
          const projection = Object.fromEntries(fields.flatMap(field => [[field, 1], [`detail_barang.${field}`, 1]]));
          const cursor = db.collection('tt_beli_detail').find(query, { projection }).maxTimeMS(20000).batchSize(500);
          const batch: Document[] = [];
          const flush = async () => {
            const items: Array<{ record: Document; tx: BuybackTransaction }> = [];
            for (const document of batch.splice(0)) for (const record of priceAuditDetails(document, 'buyback')) {
              if (++scanned > 25000) throw new BadRequestException('Lebih dari 25.000 transaksi pada tanggal pilihan. Kurangi tanggal agar seluruh data dapat diperiksa; hasil tidak dipotong.');
              const tx = buybackAuditTransaction(record, source.alias);
              if (BULLION_GROUPS.includes(record.kode_group) || /\b(?:antam|perak|silver|bullion|logam\s+mulia)\b/i.test(tx.name)) continue;
              if (autoBatch) {
                if (!references.some(ref => ref.date === tx.date && ref.rows.some(rule => rule.kind === 'buyback'))) continue;
              } else {
                const window = dto.windows.find(w => w.date === tx.date && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time) && tx.time.slice(0, 5) >= w.fromTime && tx.time.slice(0, 5) < w.toTime);
                if (!window && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time)) continue;
                if (window && !references.some(ref => window.attachmentIds.includes(ref.id) && ref.rows.some(rule => rule.kind === 'buyback'))) continue;
              }
              items.push({ record, tx });
            }
            await fillBuybackMaster(items, db, cache, this.legacy, legacyCache);
            const authorizations = await readAboveNoteBuybackAuthorizations(db, items.map(({ tx }) => tx.invoice));
            for (const { tx } of items) tx.aboveNoteAuthorization = invoiceAuthorization([tx.invoice], authorizations, 'pembelian di atas nota');
            for (const { tx } of items) {
              if (autoBatch) { sourceRows.push(auditBuybackBatches(tx, jewelryReferences)); continue; }
              const window = dto.windows.find(w => w.date === tx.date && tx.time.slice(0, 5) >= w.fromTime && tx.time.slice(0, 5) < w.toTime);
              sourceRows.push(auditBuybackTransaction(tx, window, window ? jewelryReferences.filter(ref => window.attachmentIds.includes(ref.id) || window.attachmentIds.some(id => ref.id.startsWith(`${id}#`))) : []));
            }
          };
          try { for await (const record of cursor) { batch.push(record); if (batch.length >= 200) await flush(); } if (batch.length) await flush(); }
          finally { await cursor.close(); }
          buybackRows.push(...sourceRows); available = true;
        } catch (error) {
          if (error instanceof BadRequestException) throw error;
          warnings.push(`${source.alias}: pembelian/buyback gagal dibaca. Hasil tidak dianggap lengkap.`);
        }
      }
      if (hasBullion) {
        const db = this.mongo.getDatabase(source.databaseName), sourceRows: BullionAuditRow[] = [];
        try {
          if (!await db.listCollections({ name: 'tt_beli_detail' }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
          const query = { tgl_system: { $in: dates }, status_valid: { $ne: 'CANC' }, $or: [{ kode_group: { $in: [...BULLION_GROUPS] } }, { 'detail_barang.kode_group': { $in: [...BULLION_GROUPS] } }] };
          const fields = ['_id','tgl_system','jam','no_faktur_beli','nama_barang','kode_barcode','kode_group','kode_dept','berat','harga','harga_nota','harga_rata','kondisi','input_by','status_valid'];
          const projection = Object.fromEntries(fields.flatMap(field => [[field,1],[`detail_barang.${field}`,1]]));
          const cursor = db.collection('tt_beli_detail').find(query,{projection}).maxTimeMS(20000).batchSize(500);
          const batch: Document[] = [];
          const flush = async () => {
            const items: BullionTransaction[] = [];
            for (const document of batch.splice(0)) for (const record of priceAuditDetails(document,'buyback',true)) {
              if (!BULLION_GROUPS.includes(record.kode_group)) continue;
              if (++scanned > 25000) throw new BadRequestException('Lebih dari 25.000 transaksi pada tanggal pilihan. Kurangi tanggal agar seluruh data dapat diperiksa; hasil tidak dipotong.');
              const tx = { ...priceAuditTransaction(record,'buyback',source.alias), group: String(record.kode_group) };
              if (/\b(?:perak|silver)\b/i.test(tx.name)) continue;
              if (!references.some(ref => ref.date === tx.date && ref.rows.some(rule => rule.kind === 'buyback' && rule.family === 'bullion'))) continue;
              items.push(tx);
            }
            const authorizations = await readAboveNoteBuybackAuthorizations(db,items.map(tx=>tx.invoice));
            for (const tx of items) {
              tx.aboveNoteAuthorization = invoiceAuthorization([tx.invoice],authorizations,'pembelian di atas nota');
              sourceRows.push(auditBullionBuyback(tx,references));
            }
          };
          try { for await (const record of cursor) { batch.push(record); if(batch.length>=200) await flush(); } if(batch.length) await flush(); }
          finally { await cursor.close(); }
          bullionRows.push(...sourceRows); available = true;
        } catch(error) {
          if(error instanceof BadRequestException) throw error;
          warnings.push(`${source.alias}: buyback logam mulia gagal dibaca. Hasil tidak dianggap lengkap.`);
        }
      }
      if (available) usedSources.push({ alias: source.alias, branchId: source.branchId });
    }
    rows.sort((a, b) => `${a.date} ${a.time} ${a.store} ${a.invoice}`.localeCompare(`${b.date} ${b.time} ${b.store} ${b.invoice}`));
    buybackRows.sort((a, b) => `${a.date} ${a.time} ${a.store} ${a.invoice}`.localeCompare(`${b.date} ${b.time} ${b.store} ${b.invoice}`));
    bullionRows.sort((a,b)=>`${a.date} ${a.time} ${a.store} ${a.invoice}`.localeCompare(`${b.date} ${b.time} ${b.store} ${b.invoice}`));
    bullionSalesRows.sort((a,b)=>`${a.date} ${a.time} ${a.store} ${a.invoice}`.localeCompare(`${b.date} ${b.time} ${b.store} ${b.invoice}`));
    const blocks: AgentResponseBlock[] = [
      { type: 'text', variant: 'heading', text: `Pemeriksaan harga ${[hasSales ? marketplaceOnly ? 'marketplace perhiasan' : 'penjualan perhiasan' : '',hasBullionSales?'marketplace logam mulia':'',hasBuyback ? 'buyback perhiasan' : '',hasBullion ? 'buyback logam mulia' : ''].filter(Boolean).join(' dan ')}` },
      { type: 'text', variant: 'muted', text: `Seluruh ${sources.length} toko terdaftar sesuai hak akses. ${autoBatch || autoSales || marketplaceOnly || hasBullion || hasBullionSales ? 'Transaksi diperiksa sehari penuh mengikuti tanggal dan batch pada header file, tanpa pilihan jam.' : `${dto.windows.length} acuan waktu WIB.`} ${marketplaceOnly || hasBullionSales ? 'Penjualan dibatasi ke barang pada transaksi marketplace yang masih berlaku. ' : ''}Jenis transaksi mengikuti file acuan. ${hasBullion || hasBullionSales ? 'Logam mulia diperiksa pada grup LM/LMM.' : 'Antam/logam mulia tidak termasuk tanpa file acuannya.'} Perak tidak termasuk. Transaksi buyback CANC dikeluarkan.` },
      ...(hasSales ? (['Cocok', 'Tidak cocok', 'Belum dapat diperiksa'] as const).map(status => ({ type: 'metric' as const, label: marketplaceOnly ? marketplaceStatusLabel(status) : status, value: rows.filter(row => row.status === status).length, unit: 'penjualan', tone: status === 'Cocok' ? 'teal' as const : 'amber' as const })) : []),
      ...(hasBuyback ? BUYBACK_STATUSES.map(status => ({ type: 'metric' as const, label: status, value: buybackRows.filter(row => row.status === status).length, unit: 'buyback', tone: status === BUYBACK_STATUSES[0] ? 'teal' as const : 'amber' as const })) : []),
      ...(hasBullion ? BUYBACK_STATUSES.map(status=>({type:'metric' as const,label:status,value:bullionRows.filter(row=>row.status===status).length,unit:'buyback LM',tone:status===BUYBACK_STATUSES[0]?'teal' as const:'amber' as const})) : []),
      ...(hasBullionSales?BUYBACK_STATUSES.map(status=>({type:'metric' as const,label:status,value:bullionSalesRows.filter(row=>row.status===status).length,unit:'penjualan LM marketplace',tone:status===BUYBACK_STATUSES[0]?'teal' as const:'amber' as const})):[]),
      ...(hasBullionSales?[{type:'text' as const,variant:'muted' as const,text:'Marketplace logam mulia memakai grup LM/LMM dan nama barang yang sudah didekripsi. Nama produk khusus mengikuti kategori pada file; kategori, tahun dan berat menentukan tarif. Harga diperiksa pada harga_gram. Acuan per piece ditampilkan sesuai file dan dikonversi berdasarkan berat untuk perbandingan harga_gram. Jam pada file penjualan menentukan batch; harga buyback tidak dipakai. Otorisasi faktur serta pengembalian kelebihan pembayaran tetap ditampilkan.'}]:[]),
      ...(hasBullion ? [{type:'text' as const,variant:'muted' as const,text:'Buyback logam mulia memakai nama barang yang sudah didekripsi, kategori/tahun dan berat barang. Tahun Antam didahulukan dari Redmark/Retro; Antam tanpa tahun atau varian memakai acuan 2026. EMASKU dan LM selain Antam memakai kategorinya sendiri. Harga rata transaksi dibandingkan langsung dengan tarif pada file, tanpa potongan atau perhitungan ulang. Jam berlaku pada file menentukan batch. Otorisasi faktur ditampilkan terpisah.'}] : []),
      ...(hasSales ? [{ type: 'text' as const, variant: 'muted' as const, text: marketplaceOnly
        ? `Harga per gram marketplace diperiksa per barang berdasarkan kadar pada faktur. Jika kadar belum tersedia, barcode dipakai untuk mencari kadar barang. Acuan dan selisih ditampilkan terpisah untuk setiap batch, termasuk saat harga berbeda dari seluruh acuan atau batch belum dapat ditentukan. Selisih negatif berarti harga transaksi lebih rendah dari acuan; selisih positif berarti lebih tinggi. Ongkos dan biaya marketplace dipisahkan dari harga emas. Pengembalian kelebihan pembayaran berlaku per grup faktur; nominal yang berulang pada beberapa barang tidak dijumlahkan per barang. Jika file memiliki jam berlaku, jam transaksi menentukan batch. File tanpa jam dicocokkan berdasarkan kadar dan harga; batch yang belum tunggal ditandai untuk diperhatikan. Toleransi harga: Rp${dto.toleranceRp ?? 0}.`
        : `Harga penjualan per gram dibandingkan langsung dengan gambar dan kadar barang diverifikasi. Kode intern master menentukan kode acuan; batch ditentukan dari kecocokan kode dan harga_gram, lalu ongkos diperiksa terpisah. Ongkos memakai berat dibulatkan ke gram utuh: 1,71 gram → 2 gram × Rp20.000 = Rp40.000. Toleransi tambahan penjualan: Rp${dto.toleranceRp ?? 0}.` }] : []),
      ...(hasBuyback ? [{ type: 'text' as const, variant: 'muted' as const, text: 'Harga rata per gram dibandingkan dengan acuan untuk kode intern barang pada toko yang sama. CUCI memakai harga terkecil sampai terbesar dari seluruh harga selain Ancuran luar toko, termasuk kedua ujung rentang Barang Mata/Jelek ada Cap dan harga BB Barang Bagus. Jika acuan hanya satu harga, batas bawah dan atas sama. RUSAK memakai tarif ancuran/rusak. Kedua batas termasuk; tanpa pembulatan atau potongan ulang. Barang yang tidak ditemukan tetap ditampilkan untuk diperhatikan.' }] : []),
      ...(autoBatch ? [{ type: 'text' as const, variant: 'muted' as const, text: 'Jika file mencantumkan jam berlaku, batch ditentukan dari jam transaksi: mulai termasuk, jam mulai batch berikutnya tidak termasuk. Contoh 07:00 dan 12:00: Batch 1 berlaku 07:00 sampai 11:59:59, Batch 2 mulai tepat 12:00 sampai akhir hari. Harga diperiksa terhadap batch waktunya, termasuk bila harga keliru. Transaksi sebelum acuan pertama atau tanpa jam yang valid ditampilkan untuk diperhatikan. File tanpa jam memakai pencocokan harga; jika beberapa batch memenuhi, semuanya dicantumkan sebagai belum pasti. Range tiap batch tetap terlihat.' }] : []),
    ];
    if (warnings.length) blocks.push({ type: 'callout', tone: 'warning', title: 'Pemeriksaan belum lengkap', text: warnings.join(' ') });
    const referenceWarnings = references.flatMap(ref => ref.warnings.map(w => `${ref.filename}: ${w}`));
    if (referenceWarnings.length) blocks.push({ type: 'callout', tone: 'warning', title: 'Catatan pembacaan acuan', text: referenceWarnings.join(' ').slice(0, 8000) });
    blocks.push({ type: 'table', title: 'Daftar acuan pemeriksaan harga', columns: ['Tanggal', 'Jam mulai WIB', 'Jam selesai WIB', 'File', 'Tanggal file', 'Tarif terbaca', 'Pembacaan', 'Pemetaan kadar oleh pengguna'], rows: dto.windows.flatMap(w => w.attachmentIds.map(id => { const ref = references.find(r => r.id === id)!; const manual = (dto.kadarOverrides ?? []).filter(o => o.referenceId === id).map(o => `Baris ${o.rowIndex + 1}: ${o.kadar}`).join('; '); return [w.date, w.fromTime, w.toTime, ref.filename, ref.date, ref.rows.length, ref.complete ? 'Lengkap' : 'Perlu diperiksa', manual || '—']; })) });
    if (autoBatch || autoSales || hasBullion || hasBullionSales) {
      const index = blocks.findIndex(block => block.type === 'table' && block.title === 'Daftar acuan pemeriksaan harga');
      const parts = priceReferenceParts(references);
      blocks[index] = { type: 'table', title: 'Daftar acuan pemeriksaan harga', columns: ['Tanggal', 'Batch', 'Jenis Acuan', 'Kelompok Emas', 'File', 'Tarif Terbaca', 'Pembacaan'],
        rows: parts.map(ref => [ref.date, ref.batch ? `Batch ${ref.batch}` : 'Belum terbaca', [...new Set(ref.rows.map(rule => rule.kind === 'sales' ? 'Penjualan' : 'Buyback'))].join(', '), [...new Set(ref.rows.map(rule => rule.family === 'young' ? 'Emas muda 8K/9K' : rule.family === 'bullion' ? 'Logam mulia' : 'Emas tua'))].join(', '), ref.filename, ref.rows.length, ref.complete ? 'Lengkap' : 'Perlu diperiksa']) };
      if ((hasBuyback || hasBullion || hasSales || hasBullionSales) && parts.some(ref => ref.effectiveFrom)) {
        const table = blocks[index] as Extract<AgentResponseBlock, { type: 'table' }>;
        table.columns.splice(2, 0, 'Berlaku Mulai WIB', 'Berlaku Sampai WIB');
        table.rows.forEach((row, rowIndex) => {
          const ref = parts[rowIndex];
          const period = headerSchedule(references, ref.date, ref.rows[0].kind, [ref.rows[0].family]).periods.find(item => item.batch === ref.batch);
          row.splice(2, 0, ref.effectiveFrom || 'Tidak tercantum', period ? period.toTime === '24:00' ? 'Akhir hari' : `Sebelum ${period.toTime}` : 'Belum dapat ditentukan');
        });
      }
    }
    blocks.push({ type: 'table', title: 'Audit harga penjualan perhiasan', columns: ['Tanggal', 'Jam WIB', 'Toko', 'No. Faktur', 'Barcode', 'Nama Barang', 'Kode Intern', 'Kode Acuan', 'Batch Acuan', 'Status Batch', 'Keterangan Batch', 'Tarif Acuan per Batch', 'Kadar Barang', 'Sumber Kadar', 'Berat (gram)', 'Berat Acuan Ongkos (gram)', 'Harga Acuan per gram (IDR)', 'Harga Transaksi per gram (IDR)', 'Selisih Harga per gram (IDR)', 'Ongkos Berdasarkan Berat Asli (IDR)', 'Ongkos Acuan (IDR)', 'Ongkos Transaksi (IDR)', 'Selisih Ongkos (IDR)', 'Kadar Acuan', 'Status Harga dan Kadar', 'Status Ongkos', 'Status Pemeriksaan', 'Keterangan Pemeriksaan', 'Acuan Waktu', 'File Acuan', 'Input oleh'], rows: rows.map(row => [row.date, row.time || '—', row.store, row.invoice, row.barcode || '—', row.name, row.internalCode || '-', row.code || '-', row.batch || '-', row.batchStatus || '-', row.batchReason || '-', row.batchRates || '-', row.kadar, row.kadarSource || 'Detail transaksi', row.weight, row.billedWeight, row.expectedRate, row.actualRate, row.priceDifference, row.expectedFeeUnrounded, row.expectedFee, row.fee, row.feeDifference, row.referenceKadar, row.priceStatus, row.feeStatus, row.status, row.reason, row.window, row.reference, row.inputBy]) });
    if (!hasSales) {
      const salesTable = blocks.findIndex(block => block.type === 'table' && block.title === 'Audit harga penjualan perhiasan');
      if (salesTable >= 0) blocks.splice(salesTable, 1);
    }
    if (marketplaceOnly && hasSales) {
      const salesTable = blocks.findIndex(block => block.type === 'table' && block.title === 'Audit harga penjualan perhiasan');
      blocks[salesTable] = marketplacePriceReportTable(rows, references);
    }
    if (hasBuyback) blocks.push(buybackReportTable(buybackRows, jewelryReferences, autoBatch));
    if (hasBullion) blocks.push(bullionBuybackReportTable(bullionRows,references));
    if(hasBullionSales)blocks.push(bullionMarketplaceReportTable(bullionSalesRows,references,'per-gram'));
    if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > 10 * 1024 * 1024) throw new BadRequestException('Laporan terlalu besar. Kurangi rentang tanggal; tidak ada transaksi yang dipotong diam-diam.');
    return { blocks, usedSources };
  }
}
