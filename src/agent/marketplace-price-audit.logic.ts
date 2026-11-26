import { auditPriceTransaction, type AuditTransaction, type PriceAuditRow, type PriceReference } from './price-audit.logic';
import { headerSchedule, priceReferenceParts } from './price-reference-periods';
import { BUYBACK_STATUSES } from './buyback-audit.logic';
import type { AgentResponseBlock } from './response-blocks';

const money = (value: number) => `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(value)}`;
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value);
const batchNumber = (batch: number | null | undefined) => Number.isInteger(batch) && batch! > 0 && batch! <= 999 ? batch! : null;

export function marketplaceStatusLabel(status: PriceAuditRow['status']): typeof BUYBACK_STATUSES[number] {
  return status === 'Cocok' ? BUYBACK_STATUSES[0] : status === 'Tidak cocok' ? BUYBACK_STATUSES[1] : BUYBACK_STATUSES[2];
}

/** Marketplace gold prices are checked by the item's grade, independently of codes and invoice costs. */
export function auditMarketplacePrice(tx: AuditTransaction, references: PriceReference[], tolerance = 0): PriceAuditRow {
  const day = { date: tx.date, fromTime: '00:00', toTime: '24:00', attachmentIds: references.map(ref => ref.id) };
  const base: PriceAuditRow = { ...auditPriceTransaction(tx, day, [], tolerance, true), batch: 'Belum dapat ditentukan', batchStatus: 'Belum dapat ditentukan', batchRates: '', batchReason: '' };
  const review = (reason: string): PriceAuditRow => ({ ...base, reason, batchReason: reason });
  if (tx.kind !== 'sales') return review('File harga jual dipakai untuk pemeriksaan penjualan marketplace.');
  if (tx.kadar === null || !Number.isFinite(tx.kadar) || tx.kadar <= 0) return review(tx.kadarNote || 'Kadar barang belum tersedia; harga acuan belum dapat ditentukan.');
  const priceValid = tx.pricePerGram !== null && Number.isFinite(tx.pricePerGram) && tx.pricePerGram > 0;
  const family = tx.kadar <= 60 ? 'young' : 'old';
  const dated = priceReferenceParts(references).filter(ref => ref.date === tx.date).map(ref => ({ ...ref, rows: ref.rows.filter(row => row.kind === 'sales' && row.family === family) })).filter(ref => ref.rows.length);
  if (!dated.length) return review(`File harga penjualan emas ${family === 'young' ? 'muda' : 'tua'} untuk tanggal transaksi belum tersedia.`);
  const groups = new Map<string, { batch: number | null; refs: PriceReference[] }>();
  for (const ref of dated) {
    const batch = batchNumber(ref.batch);
    const key = batch === null ? `unknown:${ref.id}` : String(batch);
    const group = groups.get(key) ?? { batch, refs: [] }; group.refs.push(ref); groups.set(key, group);
  }
  const candidates = [...groups.values()].sort((a, b) => (a.batch ?? Infinity) - (b.batch ?? Infinity)).map(group => {
    const rules = group.refs.flatMap(ref => ref.rows.filter(rule => rule.kadar === tx.kadar));
    const rates = [...new Set(rules.map(rule => rule.rate))];
    return { ...group, rules, rates, valid: group.refs.every(ref => ref.complete) && rates.length === 1 && Number.isFinite(rates[0]) && rates[0] > 0 && rules.every(rule => rule.maxRate === null || rule.maxRate === rule.rate) };
  });
  base.reference = [...new Set(dated.map(ref => ref.filename))].join('; ');
  base.referenceKadar = tx.kadar;
  base.batchRates = candidates.map(group => `${group.batch === null ? 'Batch belum terbaca' : `Batch ${group.batch}`}: ${group.rates.length ? group.rates.map(money).join(' / ') : `kadar ${tx.kadar} belum tersedia`}${group.valid ? '' : ' (perlu diperiksa)'}.`).join(' ');
  // Reference availability is independent of price conformity and batch selection.
  base.batchPrices = candidates.map(group => ({
    batch: group.batch, rate: group.valid ? group.rates[0] : null,
    difference: group.valid && priceValid ? tx.pricePerGram! - group.rates[0] : null,
    note: !group.rules.length ? `Acuan kadar ${tx.kadar} belum tersedia`
      : !group.refs.every(ref => ref.complete) ? 'Pembacaan acuan belum lengkap'
        : !group.valid ? 'Tarif acuan belum tunggal atau tidak valid' : '',
  }));
  if (!priceValid) return review('Harga per gram transaksi belum tersedia atau tidak valid; lengkapi data harga per gram.');
  const complete = candidates.filter(group => group.valid && group.batch !== null);
  const incomplete = candidates.filter(group => !group.valid || group.batch === null);
  const schedule = headerSchedule(dated, tx.date, 'sales');
  const comparison = (group: typeof candidates[number], batchConfirmed: boolean): PriceAuditRow => {
    const rate = group.rates[0], delta = tx.pricePerGram! - rate;
    const matches = Math.abs(delta) <= tolerance;
    const label = group.batch === null ? 'file tanpa nomor batch' : `Batch ${group.batch}`;
    const reason = matches ? `Harga transaksi ${money(tx.pricePerGram!)} sesuai acuan kadar ${tx.kadar} pada ${label}.`
      : `Harga transaksi ${money(tx.pricePerGram!)} lebih ${delta < 0 ? 'rendah' : 'tinggi'} ${money(Math.abs(delta))} dari acuan kadar ${tx.kadar} ${money(rate)} pada ${label}.`;
    return { ...base, expectedRate: rate, priceDifference: delta, reference: [...new Set(group.refs.map(ref => ref.filename))].join('; '),
      priceStatus: matches ? 'Cocok' : 'Tidak cocok', status: matches ? 'Cocok' : 'Tidak cocok',
      batch: batchConfirmed ? label : 'Tidak teridentifikasi', batchStatus: batchConfirmed ? 'Satu batch sesuai' : 'Tidak masuk seluruh batch',
      batchReason: batchConfirmed ? schedule.hasTimes ? 'Jam transaksi mengikuti jam berlaku pada header file.' : 'Kadar dan harga transaksi sesuai satu batch.' : 'Harga berbeda dari satu-satunya acuan kadar yang tersedia; batch transaksi belum dipastikan.',
      reason: `${reason}${batchConfirmed ? '' : ' Batch transaksi belum dapat dipastikan dari file yang tersedia.'}` };
  };
  if (schedule.hasTimes) {
    if (!schedule.valid) return review(schedule.reason);
    if (!validTime(tx.time)) return review('Jam transaksi belum tersedia atau tidak valid; batch pada file yang memiliki jam berlaku belum dapat dipilih.');
    const period = schedule.periods.find(period => tx.time.slice(0, 5) >= period.fromTime && tx.time.slice(0, 5) < period.toTime);
    if (!period) return review('Transaksi terjadi sebelum acuan harga pertama mulai berlaku.');
    const group = candidates.find(group => group.batch === period.batch)!;
    const selected = { ...base, batch: `Batch ${period.batch}`, batchStatus: 'Mengikuti jam transaksi', window: `${tx.date} ${period.fromTime}–${period.toTime} WIB` };
    if (!group?.valid) return { ...selected, reason: `Harga acuan kadar ${tx.kadar} pada Batch ${period.batch} belum tunggal atau belum terbaca lengkap.` };
    return { ...comparison(group, true), batchStatus: 'Mengikuti jam transaksi', window: selected.window };
  }
  const matched = complete.filter(group => group.rates[0] === tx.pricePerGram);
  if (matched.length === 1 && !incomplete.length) return comparison(matched[0], true);
  if (matched.length) {
    const result = comparison(matched[0], true);
    const sameRate = matched.every(group => group.rates[0] === result.expectedRate);
    return { ...result, reference: base.reference, batch: `Batch ${matched.map(group => group.batch).join(' / ')} — belum pasti`, batchStatus: 'Belum dapat ditentukan', status: 'Belum dapat diperiksa',
      expectedRate: sameRate ? result.expectedRate : null, priceDifference: 0,
      reason: `Harga transaksi ${money(tx.pricePerGram!)} sesuai kadar ${tx.kadar}, tetapi ${matched.length > 1 ? 'lebih dari satu batch memiliki harga yang sama' : 'ada acuan lain yang belum lengkap'}. Batch tunggal belum dapat ditentukan.` };
  }
  if (incomplete.length) return review(`Harga acuan kadar ${tx.kadar} atau nomor batch belum tersedia, berbeda-beda, atau pembacaan file belum lengkap. Periksa acuan yang tercantum.`);
  if (complete.length === 1) return comparison(complete[0], false);
  const differences = complete.map(group => {
    const delta = tx.pricePerGram! - group.rates[0];
    return `Batch ${group.batch}: lebih ${delta < 0 ? 'rendah' : 'tinggi'} ${money(Math.abs(delta))} dari acuan ${money(group.rates[0])}`;
  });
  return { ...base, status: 'Tidak cocok', priceStatus: 'Tidak cocok', batch: 'Tidak teridentifikasi', batchStatus: 'Tidak masuk seluruh batch',
    reason: `Harga transaksi ${money(tx.pricePerGram!)} di luar acuan kadar ${tx.kadar}. ${differences.join('; ')}. Batch belum dapat ditentukan; harga antarbatch diperiksa terpisah.` };
}

export function marketplacePriceReportTable(rows: PriceAuditRow[], references: PriceReference[] = []): Extract<AgentResponseBlock, { type: 'table' }> {
  const batches = [...new Set([
    ...priceReferenceParts(references).filter(ref => ref.rows.some(rule => rule.kind === 'sales')).map(ref => batchNumber(ref.batch)),
    ...rows.flatMap(row => (row.batchPrices ?? []).map(item => item.batch)),
  ])].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  if (!batches.length) batches.push(null);
  const batchColumns = batches.flatMap(batch => [
    `Acuan ${batch === null ? 'file tanpa batch' : `Batch ${batch}`} (IDR/gram)`,
    `Selisih ${batch === null ? 'file tanpa batch' : `Batch ${batch}`} (IDR/gram)`,
  ]);
  const batchCells = (row: PriceAuditRow) => batches.flatMap(batch => {
    const matches = (row.batchPrices ?? []).filter(item => item.batch === batch);
    if (matches.length > 1) return ['Beberapa acuan tanpa nomor batch', 'Batch belum dapat ditentukan'];
    const price = matches[0];
    const missing = price?.note || (row.kadar === null ? 'Kadar barang belum diketahui' : 'Acuan belum tersedia');
    return [price?.rate ?? missing, price?.difference ?? (price?.rate !== null && price?.rate !== undefined ? 'Harga transaksi belum tersedia' : missing)];
  });
  return { type: 'table', title: 'Audit harga penjualan marketplace perhiasan', columns: [
    'Tanggal', 'Jam WIB', 'Toko', 'Marketplace', 'No. Faktur', 'Grup Faktur', 'Barcode', 'Nama Barang', 'Kadar Barang', 'Berat (gram)',
    'Harga Jual (IDR)', 'Ongkos (IDR)', 'Pengembalian Kelebihan Pembayaran (IDR)', 'Harga Transaksi per gram (IDR)', ...batchColumns,
    'Batch Acuan', 'Acuan Waktu', 'Status Pemeriksaan', 'Keterangan Pemeriksaan', 'Otorisasi di Bawah Modal', 'Keterangan Otorisasi', 'File Acuan', 'Input oleh',
  ], rows: rows.map(row => [row.date, row.time || '—', row.store, row.marketplace || '—', row.invoice, row.invoiceGroup || '—', row.barcode || '—', row.name,
    row.kadar, row.weight, row.price, row.fee, row.overpayment ?? null, row.actualRate, ...batchCells(row), row.batch || 'Belum dapat ditentukan', row.window,
    marketplaceStatusLabel(row.status), row.reason, row.belowCostAuthorization?.status ?? 'Belum dapat diperiksa', row.belowCostAuthorization?.note ?? 'Otorisasi belum diperiksa pada laporan ini.', row.reference || 'Belum dapat ditentukan', row.inputBy]) };
}
