import { auditPriceTransaction, type AuditTransaction, type PriceReference, type PriceAuditRow } from './price-audit.logic';
import { buybackCode } from './buyback-audit.logic';

const idr = (value: number) => `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(value)}`;

/** Identify a price-reference batch by the master code and stored harga_gram.
 * Fees and invoice grades are verified AFTER batch identification, never used
 * to select a convenient batch or a different internal code. */
export function auditSalesCodeBatches(tx: AuditTransaction, references: PriceReference[], tolerance = 0): PriceAuditRow {
  const dated = references.filter(ref => ref.date === tx.date && ref.rows.some(row => row.kind === 'sales'));
  const day = { date: tx.date, fromTime: '00:00', toTime: '24:00', attachmentIds: dated.map(ref => ref.id) };
  const code = buybackCode(tx.internalCode ?? '', dated.flatMap(ref => ref.rows.filter(row => row.kind === 'sales').map(row => row.sourceCode.toUpperCase())));
  const base = { ...auditPriceTransaction(tx, day, [], tolerance, true), code, internalCode: tx.internalCode || '-', batch: 'Tidak diketahui', batchStatus: 'Belum dapat ditentukan', batchReason: '', batchRates: '' };
  const rate = tx.pricePerGram;
  const observed = rate !== null && Number.isFinite(rate) ? `Harga per gram transaksi ${idr(rate)}.` : 'Harga per gram transaksi (harga_gram) belum tersedia/valid.';
  const review = (reason: string): PriceAuditRow => ({ ...base, status: 'Belum dapat diperiksa', priceStatus: 'Belum dapat diperiksa', feeStatus: 'Belum dapat diperiksa', batchReason: reason, reason: `${reason} ${observed}` });
  if (tx.kind !== 'sales') return review('Acuan penjualan tidak dipakai untuk transaksi buyback.');
  if (tx.lookupNote || !code) return review(`${tx.lookupNote || 'Kode intern master barang belum diketahui.'} Acuan penjualan tidak ditebak dari kadar atau nominal.`);
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return review('Harga per gram pada transaksi belum valid; tidak dihitung ulang dari harga total atau ongkos.');
  const codeRules = dated.flatMap(ref => ref.rows.filter(row => row.kind === 'sales' && row.sourceCode.toUpperCase() === code));
  const families = new Set(codeRules.map(row => row.family));
  if (families.size !== 1) return review(families.size ? `Kode ${code} muncul pada beberapa kelompok emas; kelompok acuan belum dapat dipastikan.` : `Kode ${code} belum ditemukan pada file harga penjualan tanggal ini. File buyback tidak dipakai sebagai harga penjualan.`);
  const relevant = dated.filter(ref => ref.rows.some(row => row.kind === 'sales' && families.has(row.family)));
  const groups = new Map<string, { batch: number | null; refs: PriceReference[] }>();
  for (const ref of relevant) {
    const batch = typeof ref.batch === 'number' && Number.isInteger(ref.batch) && ref.batch > 0 && ref.batch <= 999 ? ref.batch : null;
    const key = batch === null ? `unknown:${ref.id}` : String(batch);
    const group = groups.get(key) ?? { batch, refs: [] }; group.refs.push(ref); groups.set(key, group);
  }
  const evaluations = [...groups.values()].sort((a, b) => (a.batch ?? Infinity) - (b.batch ?? Infinity)).map(group => {
    const refs = group.refs.map(ref => ({ ...ref, rows: ref.rows.filter(row => row.kind === 'sales' && row.sourceCode.toUpperCase() === code) }));
    const rows = refs.flatMap(ref => ref.rows);
    const complete = group.refs.every(ref => ref.complete) && rows.length > 0;
    return { ...group, rows, complete, matches: complete && rows.some(row => row.rate === rate), result: auditPriceTransaction(tx, day, refs, tolerance, true) };
  });
  const matched = evaluations.filter(group => group.matches && group.batch !== null);
  const unknown = evaluations.filter(group => !group.complete || group.batch === null);
  const batchRates = evaluations.map(group => {
    const prices = [...new Set(group.rows.map(row => row.rate))].map(idr).join(' / ');
    return `${group.batch === null ? 'Batch belum terbaca' : `Batch ${group.batch}`}: ${code} ${prices || 'tarif belum tersedia'}/gram${!group.complete ? ' (pembacaan belum lengkap)' : group.matches ? ' (harga sesuai)' : ' (harga berbeda)'}.`;
  }).join(' ');
  const reference = [...new Set(relevant.map(ref => ref.filename))].join('; ');
  if (!matched.length) {
    const hasUnknown = unknown.length > 0;
    const batchReason = hasUnknown ? 'Batch belum dapat dipastikan karena nomor batch atau tarif acuan belum lengkap.' : `Harga per gram ${idr(rate)} tidak sama dengan harga ${code} pada seluruh batch penjualan yang tersedia. Tidak dipilih batch terdekat.`;
    return { ...base, reference, batch: hasUnknown ? 'Tidak diketahui' : 'Tidak teridentifikasi', batchStatus: hasUnknown ? 'Belum dapat ditentukan' : 'Tidak masuk seluruh batch',
      status: hasUnknown ? 'Belum dapat diperiksa' : 'Tidak cocok', priceStatus: hasUnknown ? 'Belum dapat diperiksa' : 'Tidak cocok', batchReason, batchRates, reason: `${batchReason} ${batchRates}` };
  }
  const labels = matched.map(group => group.batch!);
  const ambiguous = matched.length > 1 || unknown.length > 0;
  const batch = `Batch ${labels.join(' / ')}${ambiguous ? ' — belum pasti' : ''}`;
  const batchReason = matched.length > 1 ? `Kode ${code} dan harga ${idr(rate)}/gram sesuai beberapa batch (${labels.join(', ')}); batch tunggal belum pasti.`
    : `Kode ${code} dan harga ${idr(rate)}/gram sesuai acuan Batch ${labels[0]}.${unknown.length ? ' Ada acuan lain yang belum lengkap sehingga batch tunggal belum pasti.' : ''}`;
  const chosen = matched[0].result;
  if (matched.length === 1) return { ...chosen, code, batch, batchStatus: unknown.length ? 'Belum dapat ditentukan' : 'Satu batch sesuai', batchReason, batchRates, reference,
    status: ambiguous && chosen.status === 'Cocok' ? 'Belum dapat diperiksa' : chosen.status,
    reason: `${batchReason} ${chosen.reason}` };
  // Do not pick an arbitrary batch's fee to validate ambiguous candidates.
  const sameFees = new Set(matched.map(group => `${group.result.expectedFee}:${group.result.feeStatus}`)).size === 1;
  const sameGrade = new Set(matched.map(group => `${group.result.referenceKadar}:${group.result.priceStatus}`)).size === 1;
  return { ...chosen, code, batch, batchStatus: 'Lebih dari satu batch sesuai', batchReason, batchRates, reference,
    status: 'Belum dapat diperiksa', priceStatus: sameGrade ? chosen.priceStatus : 'Belum dapat diperiksa', referenceKadar: sameGrade ? chosen.referenceKadar : null,
    feeStatus: sameFees ? chosen.feeStatus : 'Belum dapat diperiksa', expectedFee: sameFees ? chosen.expectedFee : null,
    expectedFeeUnrounded: sameFees ? chosen.expectedFeeUnrounded : null, billedWeight: sameFees ? chosen.billedWeight : null, feeDifference: sameFees ? chosen.feeDifference : null,
    reason: `${batchReason} ${sameFees ? chosen.reason : 'Ongkos antarbatch berbeda atau belum jelas; tidak dipilih berdasarkan ongkos transaksi.'} ${batchRates}` };
}
