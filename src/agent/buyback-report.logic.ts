import type { AgentResponseBlock } from './response-blocks';
import type { PriceReference } from './price-audit.logic';
import { BUYBACK_STATUSES, type BuybackAuditRow, type BuybackBatchEvaluation } from './buyback-audit.logic';
import { priceReferenceParts } from './price-reference-periods';

const money = (value: number) => `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(Math.abs(value))}`;
const hasBounds = (row: { minimum: number | null; maximum: number | null }) => row.minimum !== null && row.maximum !== null;
const range = (row: { minimum: number | null; maximum: number | null }) => row.minimum === row.maximum
  ? `${money(row.minimum!)} (harga tunggal)` : `${money(row.minimum!)}–${money(row.maximum!)}`;
const validPrice = (row: BuybackAuditRow) => row.pricePerGram !== null && Number.isFinite(row.pricePerGram) && row.pricePerGram > 0;

// Short missing-data labels are deliberate: a known range must never disappear
// merely because the observed price falls outside it or a batch is ambiguous.
function unavailable(row: BuybackAuditRow, reason = row.reason): string {
  if (row.lookupNote || !row.code && (!row.internalCode || row.internalCode === '-')) return 'Kode intern belum diketahui';
  if (!row.code) return `Label ${row.internalCode} tidak ada di acuan`;
  if (!row.condition.trim() || /belum dapat didekripsi/i.test(reason)) return 'Kondisi belum terbaca';
  if (/tidak ditemukan pada file/i.test(reason)) return `Kode ${row.code} tidak ada di file`;
  if (/belum lengkap/i.test(reason)) return 'Pembacaan acuan belum lengkap';
  if (/8K\/9K belum dapat dibedakan|beberapa varian|varian barang/i.test(reason)) return 'Varian kadar belum dapat ditentukan';
  return 'Batas acuan belum dapat ditentukan';
}

function userReason(reason: string): string {
  return reason.replace(/tm_barang/g, 'master barang').replace(/Field harga_rata/g, 'Harga rata transaksi')
    .replace(/\s*(?:\/\s*gram|per\s+gram)\b/gi, '')
    .replace(/\s*Range tidak dipilih berdasarkan nominal transaksi\./g, '')
    .replace(/\s*Sel kosong tidak dianggap nol\./g, '').trim();
}

function differenceReason(difference: number, reference: string): string {
  return `Harga buyback lebih ${difference < 0 ? 'rendah' : 'tinggi'} ${money(difference)} dari batas ${difference < 0 ? 'bawah' : 'atas'} acuan ${reference}`;
}

function explanation(row: BuybackAuditRow, evaluations: BuybackBatchEvaluation[]): string {
  if (row.batchBasis === 'time') {
    if (row.assignedBatch === undefined) return userReason(row.reason);
    const prefix = `Pukul ${row.time} WIB masuk Batch ${row.assignedBatch}.`;
    if (row.status === BUYBACK_STATUSES[0]) return `${prefix} Harga masih dalam acuan batch ini.`;
    if (!validPrice(row)) return `${prefix} Harga rata transaksi belum tersedia atau tidak valid.`;
    const selected = evaluations.find(item => item.batch === row.assignedBatch);
    if (selected?.difference !== null && selected?.difference !== undefined && selected.difference !== 0) return `${prefix} ${differenceReason(selected.difference, `Batch ${row.assignedBatch}`)}.`;
    return `${prefix} ${userReason(selected?.reason || row.reason.replace(row.batchReason || '', '').trim())}`;
  }
  if (row.lookupNote || !row.code) {
    const cause = row.lookupNote ? userReason(row.lookupNote).replace(/[.\s]+$/, '')
      : row.internalCode && row.internalCode !== '-' ? `Kode/label intern ${row.internalCode} belum ditemukan pada file acuan` : 'Kode intern barang belum dapat dibaca';
    return `${cause}; acuan belum dapat ditentukan. ${validPrice(row) ? `Harga rata transaksi ${money(row.pricePerGram!)}.` : 'Harga rata transaksi belum tersedia atau tidak valid.'}`;
  }
  if (!validPrice(row)) return 'Harga rata transaksi belum tersedia atau tidak valid; harga belum dapat dibandingkan dengan acuan.';
  if (!evaluations.length) return row.difference !== null && row.difference !== 0
    ? `${differenceReason(row.difference, `kode ${row.code}`)}.` : userReason(row.reason);
  const matches = evaluations.filter(item => item.status === BUYBACK_STATUSES[0]);
  const unresolved = evaluations.filter(item => item.batch === null || item.status === BUYBACK_STATUSES[2]);
  const names = (items: BuybackBatchEvaluation[]) => items.map(item => item.batch === null ? 'file tanpa nomor batch' : `Batch ${item.batch}`).join(' dan ');
  if (matches.length > 1) return `Harga masih dalam acuan ${names(matches)}; batch tunggal belum dapat ditentukan.${unresolved.length ? ' Ada acuan lain yang belum dapat diperiksa.' : ''}`;
  if (matches.length === 1) return `Harga masih dalam acuan ${names(matches)}${unresolved.length ? `; ${names(unresolved)} belum dapat dipastikan.` : evaluations.length > 1 ? ' saja.' : '.'}`;
  const deltas = evaluations.filter(item => hasBounds(item) && item.difference !== null).map(item =>
    differenceReason(item.difference!, item.batch === null ? 'file tanpa nomor batch' : `Batch ${item.batch}`));
  const incomplete = unresolved.map(item => `${item.batch === null ? 'File tanpa nomor batch' : `Batch ${item.batch}`}: ${item.batch === null && hasBounds(item) && item.status !== BUYBACK_STATUSES[2] ? 'nomor batch pada header belum terbaca' : unavailable(row, item.reason).toLowerCase()}`);
  return [...deltas, ...incomplete].join('; ') + '.';
}

/** One readable comparison per transaction, shared by the table view and Excel. */
export function buybackReportTable(rows: BuybackAuditRow[], references: PriceReference[], autoBatch: boolean): Extract<AgentResponseBlock, { type: 'table' }> {
  const buybackRefs = priceReferenceParts(references).filter(ref => ref.rows.some(rule => rule.kind === 'buyback'));
  const timed = autoBatch && buybackRefs.some(ref => Boolean(ref.effectiveFrom));
  const batches = [...new Set(buybackRefs.map(ref => ref.batch ?? null))].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const rangeColumns = autoBatch ? batches.map(batch => batch === null ? 'Range file tanpa nomor batch (IDR/gram)' : `Range Batch ${batch} (IDR/gram)`) : ['Range acuan (IDR/gram)'];
  return { type: 'table', title: 'Audit harga buyback perhiasan', columns: [
    'Tanggal', 'Jam WIB', 'Toko', 'No. Faktur', 'Nama Barang', 'Kode Intern', 'Kondisi',
    'Berat (gram)', 'Harga Buyback (IDR)', 'Harga Nota (IDR)', 'Harga Rata per gram (IDR)', ...rangeColumns, ...(timed ? ['Batch Acuan', 'Dasar Penentuan Batch', 'Berlaku WIB'] : ['Batch yang Sesuai']), 'Hasil Pemeriksaan', 'Keterangan Pemeriksaan',
    'Barcode', 'Kode Acuan', 'Kadar Cetak', ...(!autoBatch ? ['Acuan Waktu'] : []), 'File Acuan', 'Input oleh',
  ], rows: rows.map(row => {
    const evaluations = row.batchEvaluations ?? [];
    const rangeCells = autoBatch ? batches.map(batch => {
      const applicable = evaluations.filter(item => item.batch === batch);
      if (applicable.length) return applicable.map(item => hasBounds(item) ? range(item) : unavailable(row, item.reason)).join('; ');
      if (!buybackRefs.some(ref => ref.date === row.date && (ref.batch ?? null) === batch)) return 'File batch tidak tersedia untuk tanggal ini';
      if (row.lookupNote || !row.code) return unavailable(row);
      return unavailable(row);
    }) : [hasBounds(row) ? range(row) : unavailable(row)];
    const matches = evaluations.filter(item => item.batch !== null && item.status === BUYBACK_STATUSES[0]);
    const batch = row.batchBasis === 'time' ? row.batch || 'Belum dapat ditentukan' : !autoBatch ? 'Mengikuti acuan waktu' : matches.length
      ? matches.map(item => `Batch ${item.batch}`).join(' dan ') + (evaluations.some(item => item.batch === null || item.status === BUYBACK_STATUSES[2]) ? ' (belum pasti)' : '')
      : row.status === BUYBACK_STATUSES[1] ? 'Tidak masuk batch mana pun' : 'Belum dapat ditentukan';
    return [row.date, row.time || 'Belum tersedia', row.store, row.invoice, row.name, row.internalCode || '-', row.condition || 'Belum terbaca',
      row.weight, row.price, row.invoicePrice ?? null, row.pricePerGram ?? 'Belum tersedia', ...rangeCells, batch,
      ...(timed ? [row.batchBasis === 'time' ? 'Jam transaksi' : 'Harga (file tanpa jam)', row.effectiveFrom ? `${row.effectiveFrom}–${row.effectiveTo === '24:00' ? 'akhir hari' : `sebelum ${row.effectiveTo}`}` : row.batchBasis === 'time' ? 'Belum dapat ditentukan' : 'Tidak tercantum pada file'] : []),
      row.status, explanation(row, evaluations), row.barcode || 'Tidak tersedia', row.code || '-',
      row.printedKadar || 'Tidak tersedia', ...(!autoBatch ? [row.window] : []), row.reference || 'Belum dapat ditentukan', row.inputBy];
  }) };
}
