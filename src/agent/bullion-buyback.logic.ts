import type { AuditTransaction, BullionProduct, PriceReference } from './price-audit.logic';
import { BUYBACK_STATUSES } from './buyback-audit.logic';
import { headerSchedule, inHeaderPeriod, priceReferenceParts } from './price-reference-periods';
import type { AgentResponseBlock } from './response-blocks';

export const BULLION_GROUPS = ['LM', 'LMM'] as const;
export type BullionTransaction = AuditTransaction & { group: string };
type Identity = { product: BullionProduct | null; year: number | null; label: string; reason: string };
type Comparison = { batch: number | null; rate: number | null; difference: number | null; reason: string };
export type BullionAuditRow = BullionTransaction & {
  identity: Identity; comparisons: Comparison[]; batch: string; period: string;
  status: typeof BUYBACK_STATUSES[number]; reason: string; reference: string;
};
const money = (value: number) => `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(Math.abs(value))}`;
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

/** Name has already been decrypted by priceAuditTransaction. Years outrank Antam variants. */
export function bullionIdentity(name: string): Identity {
  const text = name.toUpperCase().replace(/\s+/g, ' ').trim();
  const unknown = (reason: string): Identity => ({ product: null, year: null, label: 'Belum dapat ditentukan', reason });
  if (!text || text === '-' || /^(?:[A-F\d]{2})+$/.test(text)) return unknown('Nama barang belum tersedia atau belum dapat didekripsi.');
  if (/\b(?:PERAK|SILVER)\b/.test(text)) return unknown('Barang perak tidak termasuk audit buyback logam mulia emas.');
  if (/\bANTAM\b/.test(text)) {
    const years = [...new Set([...text.matchAll(/\b((?:19|20|21)\d{2})\b/g)].map(match => Number(match[1])))];
    if (years.length > 1) return unknown('Nama barang memuat beberapa tahun; acuan tahun belum dapat ditentukan.');
    if (years.length) return { product: 'ANTAM_YEAR', year: years[0], label: `ANTAM ${years[0]}`, reason: `Tahun ${years[0]} pada nama barang didahulukan dari varian Antam.` };
    const red = /\b(?:RED(?:\s*MARK)?|REDMARK)\b/.test(text), retro = /\bRETRO\b/.test(text);
    if (red && retro) return unknown('Nama barang memuat Redmark dan Retro; varian Antam belum dapat ditentukan.');
    if (red) return { product: 'ANTAM_REDMARK', year: null, label: 'ANTAM Redmark', reason: 'Nama barang menyebut RED/REDMARK tanpa tahun.' };
    if (retro) return { product: 'ANTAM_RETRO', year: null, label: 'ANTAM Retro', reason: 'Nama barang menyebut RETRO tanpa tahun.' };
    return { product: 'ANTAM_YEAR', year: 2026, label: 'ANTAM 2026', reason: 'Antam tanpa tahun dan tanpa varian memakai acuan 2026 sesuai aturan pemeriksaan.' };
  }
  if (/\bEMAS\s*KU\b/.test(text)) return { product: 'EMASKU', year: null, label: 'EMASKU', reason: 'Nama barang menyebut EMASKU.' };
  return { product: 'OTHER_LM', year: null, label: 'LM selain ANTAM', reason: 'Barang pada grup LM/LMM tidak menyebut ANTAM atau EMASKU.' };
}

export function auditBullionBuyback(tx: BullionTransaction, references: PriceReference[]): BullionAuditRow {
  const identity = bullionIdentity(tx.name);
  const allParts = priceReferenceParts(references).filter(ref => ref.date === tx.date && ref.rows.some(rule => rule.kind === 'buyback' && rule.family === 'bullion'));
  const base: BullionAuditRow = { ...tx, identity, comparisons: [], batch: 'Belum dapat ditentukan', period: 'Belum dapat ditentukan', status: BUYBACK_STATUSES[2], reason: '', reference: [...new Set(allParts.map(ref => ref.filename))].join('; ') };
  const review = (reason: string): BullionAuditRow => ({ ...base, reason });
  if (!BULLION_GROUPS.includes(tx.group as typeof BULLION_GROUPS[number])) return review('Kode grup barang bukan LM/LMM.');
  if (!identity.product) return review(identity.reason);
  if (!allParts.length) return review('File acuan buyback logam mulia untuk tanggal transaksi belum tersedia.');
  // The OTHER_LM footer may have its own schedule in a jewelry file. Do not
  // impose that header on Antam/EMASKU categories, or borrow their hours back.
  const parts = allParts.filter(ref => ref.rows.some(rule => rule.family === 'bullion' && rule.kind === 'buyback' && rule.bullionProduct === identity.product && (identity.product !== 'ANTAM_YEAR' || rule.bullionYear === identity.year)));
  if (!parts.length) return review(`Acuan ${identity.label} belum tersedia untuk tanggal transaksi ini.`);
  base.reference = [...new Set(parts.map(ref=>ref.filename))].join('; ');
  const groups = new Map<string, PriceReference[]>();
  for (const ref of parts) { const key = ref.batch == null ? ref.id : String(ref.batch); groups.set(key, [...(groups.get(key) ?? []), ref]); }
  base.comparisons = [...groups.values()].map(refs => {
    const matching = refs.flatMap(ref => ref.rows.filter(rule => rule.family === 'bullion' && rule.kind === 'buyback' && rule.bullionProduct === identity.product &&
      (identity.product !== 'ANTAM_YEAR' || rule.bullionYear === identity.year) &&
      positive(tx.weight) && (rule.bullionWeightGram === tx.weight || identity.product === 'OTHER_LM' && rule.bullionWeightGram === null)));
    const rates = [...new Set(matching.map(rule => rule.rate))];
    const valid = refs.every(ref => ref.complete) && rates.length === 1 && positive(rates[0]) && matching.every(rule => rule.maxRate === null || rule.maxRate === rule.rate);
    const rate = valid ? rates[0] : null;
    return { batch: refs[0].batch ?? null, rate, difference: rate !== null && positive(tx.pricePerGram) ? tx.pricePerGram - rate : null,
      reason: !matching.length ? `Tarif ${identity.label} untuk berat ${tx.weight} gram belum tersedia pada file.` : !valid ? 'Tarif acuan belum tunggal atau pembacaan file belum lengkap.' : '' };
  }).sort((a, b) => (a.batch ?? Infinity) - (b.batch ?? Infinity));
  // Keep known category/weight prices visible even before the first batch or
  // when a transaction clock is missing. Price availability is independent.
  const schedule = headerSchedule(parts, tx.date, 'buyback', ['bullion']);
  if (schedule.hasTimes) {
    if (!schedule.valid) return review(schedule.reason);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time)) return review('Jam transaksi belum tersedia atau tidak valid; batch belum dapat ditentukan.');
    const period = schedule.periods.find(item => inHeaderPeriod(tx.time, item));
    if (!period) return review(`Transaksi terjadi sebelum acuan pertama berlaku pukul ${schedule.periods[0].fromTime} WIB.`);
    base.batch = `Batch ${period.batch}`; base.period = `${period.fromTime}–${period.toTime === '24:00' ? 'akhir hari' : `sebelum ${period.toTime}`} WIB`;
  }
  if (!positive(tx.weight)) return review('Berat barang belum tersedia atau tidak valid; baris berat acuan belum dapat dipilih.');
  let selected: Comparison | undefined;
  if (schedule.hasTimes) {
    selected = base.comparisons.find(item => `Batch ${item.batch}` === base.batch);
    if (selected?.rate === null || !selected) return review(selected?.reason || 'Tarif batch transaksi belum tersedia.');
  }
  if (!positive(tx.pricePerGram)) return review('Harga rata transaksi belum tersedia atau tidak valid.');
  if (!schedule.hasTimes) {
    const matched = base.comparisons.filter(item => item.rate === tx.pricePerGram && item.batch !== null);
    const unresolved = base.comparisons.some(item => item.rate === null || item.batch === null);
    if (unresolved || matched.length > 1) return review(`${identity.reason} ${matched.length > 1 ? 'Harga sesuai lebih dari satu batch; batch tunggal belum pasti.' : 'Tarif atau nomor batch belum terbaca lengkap; batch belum dapat ditentukan.'}`);
    if (matched.length === 1) { selected = matched[0]; base.batch = `Batch ${selected.batch}`; }
    else return { ...base, status: BUYBACK_STATUSES[1], batch: 'Tidak teridentifikasi', period: 'Jam tidak tercantum pada file', reason: `${identity.reason} Harga buyback berbeda dari seluruh acuan kategori dan berat yang tersedia; batch tidak dipilih dari harga terdekat.` };
    base.period = 'Jam tidak tercantum pada file';
  }
  const difference = selected!.difference!;
  return { ...base, status: difference === 0 ? BUYBACK_STATUSES[0] : BUYBACK_STATUSES[1], reason: `${identity.reason} ${base.batch}. ${difference === 0 ? 'Harga rata transaksi sesuai acuan.' : `Harga buyback lebih ${difference < 0 ? 'rendah' : 'tinggi'} ${money(difference)} dari acuan ${money(selected!.rate!)}.`}` };
}

export function bullionBuybackReportTable(rows: BullionAuditRow[], references: PriceReference[]): Extract<AgentResponseBlock, { type: 'table' }> {
  const batches = [...new Set(priceReferenceParts(references).filter(ref => ref.rows.some(rule => rule.kind === 'buyback' && rule.family === 'bullion')).map(ref => ref.batch ?? null))].sort((a,b)=>(a??Infinity)-(b??Infinity));
  const columns = batches.flatMap(batch => [`Acuan ${batch === null ? 'file tanpa batch' : `Batch ${batch}`} (IDR/gram)`, `Selisih ${batch === null ? 'file tanpa batch' : `Batch ${batch}`} (IDR/gram)`]);
  return { type: 'table', title: 'Audit harga buyback logam mulia', columns: ['Tanggal','Jam WIB','Toko','No. Faktur','Barcode','Nama Barang','Kode Grup','Kategori Acuan','Dasar Kategori','Kondisi','Berat (gram)','Harga Buyback (IDR)','Harga Nota (IDR)','Harga Rata per gram (IDR)',...columns,'Batch Acuan','Berlaku WIB','Hasil Pemeriksaan','Keterangan Pemeriksaan','Otorisasi di Atas Nota','Deskripsi Otorisasi','Keterangan Otorisasi','File Acuan','Input oleh'],
    rows: rows.map(row => [row.date,row.time || 'Belum tersedia',row.store,row.invoice,row.barcode || 'Tidak tersedia',row.name,row.group,row.identity.label,row.identity.reason,row.condition || 'Tidak tersedia',row.weight,row.price,row.invoicePrice ?? null,row.pricePerGram,
      ...batches.flatMap(batch => { const found = row.comparisons.filter(item=>item.batch===batch); const item=found.length===1?found[0]:null; return [item?.rate ?? (item?.reason || 'Acuan belum dapat ditentukan'), item?.difference ?? (item?.reason || 'Belum dapat dihitung')]; }),
      row.batch,row.period,row.status,row.reason,row.aboveNoteAuthorization?.status ?? 'Belum dapat diperiksa',row.aboveNoteAuthorization?.description ?? 'Tidak ditemukan',row.aboveNoteAuthorization?.note ?? 'Otorisasi belum diperiksa pada laporan ini.',row.reference || 'Belum dapat ditentukan',row.inputBy]) };
}
