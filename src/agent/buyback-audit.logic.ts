import type { AuditTransaction, PriceReference, PriceRule, PriceWindow } from './price-audit.logic';
import { headerSchedule, inHeaderPeriod, priceReferenceParts } from './price-reference-periods';
import { buybackIdentity, matchesBuybackIdentity } from './buyback-identity.logic';
export { buybackCode } from './buyback-identity.logic';

export type BuybackTransaction = AuditTransaction & { internalCode: string; printedKadar: string; lookupNote?: string };
export const BUYBACK_STATUSES = ['Masih dalam batas range acuan', 'Di luar range acuan', 'Perlu diperhatikan'] as const;
export type BuybackBatchEvaluation = {
  batch: number | null; referenceIds: string[]; reference: string;
  minimum: number | null; maximum: number | null; difference: number | null;
  status: typeof BUYBACK_STATUSES[number]; reason: string;
};
export type BuybackAuditRow = BuybackTransaction & {
  code: string; minimum: number | null; maximum: number | null; difference: number | null;
  status: typeof BUYBACK_STATUSES[number]; reason: string; reference: string; window: string;
  batch?: string; batchStatus?: string; batchReason?: string; batchRanges?: string;
  priceStatus?: typeof BUYBACK_STATUSES[number];
  batchEvaluations?: BuybackBatchEvaluation[];
  batchBasis?: 'time' | 'price'; assignedBatch?: number; effectiveFrom?: string; effectiveTo?: string;
};

const idr = (value: number) => `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(Math.abs(value))}`;
const printedKey = (value: string) => value.toUpperCase().replace(/\s+/g, '').trim();
type Rule = PriceRule & { file: string; complete: boolean; group: string };

export function auditBuybackTransaction(tx: BuybackTransaction, window: PriceWindow | undefined, references: PriceReference[], fullDay = false): BuybackAuditRow {
  const identity = buybackIdentity(tx.internalCode, references);
  const result: BuybackAuditRow = {
    ...tx, code: identity.code, minimum: null, maximum: null, difference: null,
    status: 'Perlu diperhatikan', reason: '', reference: '',
    window: window ? fullDay ? `${window.date} sehari penuh WIB` : `${window.date} ${window.fromTime}–${window.toTime} WIB` : 'Acuan belum tersedia',
  };
  const actual = tx.pricePerGram;
  const observed = actual !== null && Number.isFinite(actual) ? `Harga rata transaksi ${idr(actual)}/gram.` : 'Harga rata transaksi belum tersedia/valid.';
  const review = (reason: string) => ({ ...result, reason: `${reason} ${observed}` });
  if (!window || (!fullDay && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time))) return review('Jam transaksi tidak tersedia/valid; acuan waktu belum dapat ditentukan.');
  if (tx.date !== window.date || (!fullDay && !inHeaderPeriod(tx.time, window))) return review('Transaksi berada di luar tanggal/jam acuan.');
  if (tx.lookupNote || !result.code) return review(`${tx.lookupNote || (tx.internalCode && tx.internalCode !== '-' ? `Kode/label intern ${tx.internalCode} belum ditemukan pada file acuan.` : 'Kode internal barang tidak diketahui atau tidak dapat dibaca.')} Range acuan belum dapat ditentukan.`);
  if (!tx.condition.trim() || /^(?:[A-F0-9]{2})+$/i.test(tx.condition.trim())) return review('Kondisi transaksi kosong atau belum dapat didekripsi; kategori RUSAK/selain RUSAK belum dapat dipastikan.');
  const damaged = /RUSAK|ANCUR|HANCUR|RONGSOK/i.test(tx.condition);
  let rules: Rule[] = references.flatMap(ref => ref.rows.filter(row => row.kind === 'buyback' && row.family !== 'bullion').map(row => ({ ...row, file: ref.filename, complete: ref.complete, group: `${ref.id}:${row.sourceRow ?? `${row.sourceCode}:${row.printedKadar ?? ''}`}` })));
  const codeRules = rules.filter(row => matchesBuybackIdentity(row, identity));
  if (!codeRules.length) return review(`Kode ${result.code} tidak ditemukan pada file buyback dalam acuan waktu ini.`);
  const families = new Set(codeRules.map(row => row.family));
  if (families.size !== 1) return review(`Kode ${result.code} tercatat pada beberapa kelompok emas; periksa file acuan.`);
  const family = codeRules[0].family;
  if (family === 'young' && damaged) {
    // A shared condition "RUSAK 8K / 9K" does not identify which damaged tariff applies.
    const explicit = (value: string) => {
      const eight = /\b8\s*K\b/i.test(value), nine = /\b9\s*K\b/i.test(value);
      return eight !== nine ? eight ? 'DAMAGED_8' : 'DAMAGED_9' : null;
    };
    const printed = printedKey(tx.printedKadar);
    const category = explicit(tx.printedKadar) ?? (printed === '8' ? 'DAMAGED_8' : printed === '9' ? 'DAMAGED_9' : null) ?? explicit(tx.condition);
    if (!category) return review('Barang RUSAK 8K/9K belum dapat dibedakan dari kadar cetak atau kondisi; tarif 8K/9K tidak ditebak.');
    rules = rules.filter(row => row.family === 'young' && row.condition === category);
  } else {
    rules = codeRules.filter(row => damaged ? row.condition === 'SCRAP' : ['GOOD', 'STONE', 'ANY'].includes(row.condition));
    // Printed qualifiers disambiguate repeated codes only when explicitly known.
    const qualifiers = new Set(rules.map(row => printedKey(row.printedKadar ?? '')).filter(Boolean));
    if (qualifiers.size > 1) {
      const matching = rules.filter(row => printedKey(row.printedKadar ?? '') === printedKey(tx.printedKadar) && tx.printedKadar.trim());
      if (!matching.length) return review(`Kode ${result.code} memiliki beberapa varian acuan; kadar cetak belum membedakannya.`);
      rules = matching;
    }
  }
  if (!rules.length) return review(`Tarif ${damaged ? 'RUSAK' : 'selain RUSAK'} untuk kode ${result.code} belum tersedia.`);
  result.reference = [...new Set(rules.map(row => row.file))].join('; ');
  if (rules.some(row => !row.complete)) return review('Pembacaan file acuan terkait belum lengkap; periksa tarif sebelum menetapkan range.');
  const groups = new Map<string, Rule[]>();
  for (const rule of rules) groups.set(rule.group, [...(groups.get(rule.group) ?? []), rule]);
  const intervals: Array<{ minimum: number; maximum: number }> = [];
  const single = (items: Rule[], endpoint: 'rate' | 'maxRate' = 'rate'): number | null => {
    const values = [...new Set(items.map(row => endpoint === 'maxRate' ? row.maxRate : row.rate))];
    return values.length === 1 && values[0] !== null && Number.isFinite(values[0]) && values[0] > 0 ? values[0] : null;
  };
  for (const group of groups.values()) {
    let minimum: number | null, maximum: number | null;
    if (damaged) {
      minimum = single(group); maximum = minimum;
    } else {
      // CUCI uses every printed non-scrap price for this physical code row.
      // D7: GOOD 1533, STONE 1491–1523 => accepted 1491–1533 (thousands).
      // A young-gold row with one printed buyback price remains a point range.
      const valid = group.every(row => Number.isFinite(row.rate) && row.rate > 0
        && (row.condition !== 'STONE' || row.maxRate !== null)
        && (row.maxRate === null || Number.isFinite(row.maxRate) && row.maxRate >= row.rate));
      const conditions = new Set(group.map(row => row.condition));
      const conflicting = [...conditions].some(condition => new Set(group.filter(row => row.condition === condition).map(row => `${row.rate}:${row.maxRate}`)).size > 1);
      if (!valid || conflicting) return review(`Tarif selain ancuran untuk kode ${result.code} belum lengkap, berbeda pada kategori yang sama, atau rentangnya tidak berurutan.`);
      const amounts = group.flatMap(row => row.maxRate === null ? [row.rate] : [row.rate, row.maxRate]);
      minimum = Math.min(...amounts); maximum = Math.max(...amounts);
    }
    if (minimum === null || maximum === null || minimum > maximum) return review(`Batas range kode ${result.code} kosong, tidak tunggal, atau tidak berurutan. Sel kosong tidak dianggap nol.`);
    intervals.push({ minimum, maximum });
  }
  const distinct = [...new Set(intervals.map(row => `${row.minimum}:${row.maximum}`))];
  if (distinct.length !== 1) return review(`Kode ${result.code} memiliki beberapa range acuan berbeda; varian barang belum dapat dipastikan. Range tidak dipilih berdasarkan nominal transaksi.`);
  const { minimum, maximum } = intervals[0];
  result.minimum = minimum; result.maximum = maximum;
  if (actual === null || !Number.isFinite(actual) || actual <= 0) return review('Field harga_rata belum tersedia/valid; nominal tidak dihitung ulang dari total dan berat.');
  result.difference = actual < minimum ? actual - minimum : actual > maximum ? actual - maximum : 0;
  result.status = result.difference === 0 ? 'Masih dalam batas range acuan' : 'Di luar range acuan';
  const range = minimum === maximum ? `${idr(minimum)}/gram (batas tunggal)` : `${idr(minimum)}–${idr(maximum)}/gram`;
  result.reason = result.difference === 0
    ? `Harga rata ${idr(actual)}/gram masih dalam batas range acuan ${result.code} ${range}, termasuk kedua batas, untuk kondisi ${tx.condition}.`
    : `Harga rata ${idr(actual)}/gram ${result.difference < 0 ? 'lebih rendah dari batas bawah' : 'melebihi batas atas'} ${idr(result.difference)}/gram. Acuan ${result.code} ${range}, kondisi ${tx.condition}.`;
  return result;
}

/** Printed effective hours determine the batch first; files without hours use price compatibility. */
export function auditBuybackBatches(tx: BuybackTransaction, references: PriceReference[]): BuybackAuditRow {
  const dated = priceReferenceParts(references).filter(ref => ref.date === tx.date && ref.rows.some(row => row.kind === 'buyback' && row.family !== 'bullion'));
  if (headerSchedule(dated, tx.date, 'buyback', ['young','old']).hasTimes) return auditBuybackByHeaderTime(tx, dated);
  const day = { date: tx.date, fromTime: '00:00', toTime: '24:00', attachmentIds: dated.map(ref => ref.id) };
  const base = auditBuybackTransaction(tx, day, dated, true);
  const unresolved = (reason: string): BuybackAuditRow => ({ ...base, minimum: null, maximum: null, difference: null,
    status: 'Perlu diperhatikan', priceStatus: 'Perlu diperhatikan', batch: 'Tidak diketahui', batchStatus: 'Belum dapat ditentukan', batchReason: reason, batchRanges: '', batchEvaluations: [], batchBasis: 'price', reason });
  if (!dated.length) return unresolved('Tidak ada file buyback untuk tanggal transaksi ini. Batch belum dapat ditentukan.');
  if (tx.lookupNote || !base.code) return unresolved(base.reason);
  const identity = buybackIdentity(tx.internalCode, dated);
  const families = new Set(dated.flatMap(ref => ref.rows.filter(row => row.kind === 'buyback' && matchesBuybackIdentity(row, identity)).map(row => row.family)));
  if (families.size !== 1) return unresolved(base.reason);
  const relevant = dated.filter(ref => ref.rows.some(row => row.kind === 'buyback' && families.has(row.family)));
  const groups = new Map<string, { batch: number | null; refs: PriceReference[] }>();
  for (const ref of relevant) {
    const batch = typeof ref.batch === 'number' && Number.isInteger(ref.batch) && ref.batch > 0 && ref.batch <= 999 ? ref.batch : null;
    const key = batch === null ? `unknown:${ref.id}` : String(batch);
    const group = groups.get(key) ?? { batch, refs: [] }; group.refs.push(ref); groups.set(key, group);
  }
  const evaluated = [...groups.values()].sort((a, b) => (a.batch ?? Infinity) - (b.batch ?? Infinity)).map(group => ({
    ...group, result: auditBuybackTransaction(tx, day, group.refs, true),
  }));
  const matches = evaluated.filter(row => row.batch !== null && row.result.status === BUYBACK_STATUSES[0]);
  const unknown = evaluated.filter(row => row.batch === null || row.result.status === 'Perlu diperhatikan');
  const label = (row: typeof evaluated[number]) => row.batch === null ? `Batch belum terbaca (${row.refs.map(ref => ref.filename).join(', ')})` : `Batch ${row.batch}`;
  const batchRanges = evaluated.map(row => {
    const result = row.result;
    if (result.minimum === null || result.maximum === null) return `${label(row)}: ${result.reason}`;
    const range = result.minimum === result.maximum ? idr(result.minimum) : `${idr(result.minimum)}–${idr(result.maximum)}`;
    const outcome = result.status === BUYBACK_STATUSES[0] ? 'dalam range' : `${result.difference! < 0 ? 'di bawah batas bawah' : 'di atas batas atas'} ${idr(result.difference!)}/gram`;
    return `${label(row)}: ${range}/gram (${outcome}).`;
  }).join(' ');
  const matchedLabels = matches.map(row => row.batch!);
  const priceStatus = matches.length || evaluated.some(row => row.result.status === BUYBACK_STATUSES[0]) ? BUYBACK_STATUSES[0] : unknown.length ? 'Perlu diperhatikan' : BUYBACK_STATUSES[1];
  const reference = [...new Set(relevant.map(ref => ref.filename))].join('; ');
  const observed = tx.pricePerGram !== null && Number.isFinite(tx.pricePerGram) ? `Harga rata ${idr(tx.pricePerGram)}/gram` : 'Harga rata transaksi belum tersedia/valid';
  const uncertain = matches.length > 1 || unknown.length > 0;
  const batch = matches.length === 1 ? `Batch ${matchedLabels[0]}${unknown.length ? ' — belum pasti' : ''}`
    : matches.length > 1 ? `Batch ${matchedLabels.join(' / ')} — belum pasti`
      : unknown.length ? 'Tidak diketahui' : 'Tidak teridentifikasi';
  const batchStatus = matches.length > 1 ? 'Lebih dari satu batch sesuai' : unknown.length ? 'Belum dapat ditentukan' : matches.length ? 'Satu batch sesuai' : 'Tidak masuk seluruh batch';
  const batchReason = matches.length > 1
    ? `${observed} masuk ke ${matchedLabels.map(n => `Batch ${n}`).join(' dan ')}. Batch tunggal belum pasti; tidak dipilih otomatis berdasarkan batch terbaru.${unknown.length ? ' Ada acuan lain yang belum dapat diperiksa.' : ''}`
    : matches.length === 1 ? `${observed} sesuai acuan Batch ${matchedLabels[0]} dari file yang diunggah.${unknown.length ? ' Ada batch/header acuan lain yang belum dapat diperiksa, sehingga batch tunggal belum pasti.' : ' Batch lain yang tersedia tidak memenuhi range.'}`
      : unknown.length ? `${observed}. Batch belum dapat ditentukan karena data/header atau tarif acuan belum cukup; lihat rincian per batch.`
        : `${observed} berada di luar seluruh range batch yang tersedia untuk kode ${base.code} dan kondisi ${tx.condition}. Tidak dipilih batch terdekat.`;
  const selected = matches.length === 1 ? matches[0].result : null;
  const batchEvaluations = evaluated.map(({ batch, refs, result }) => ({ batch,
    referenceIds: refs.map(ref => ref.id), reference: result.reference || refs.map(ref => ref.filename).join('; '),
    minimum: result.minimum, maximum: result.maximum, difference: result.difference, status: result.status, reason: result.reason,
  }));
  return { ...base, reference, minimum: selected?.minimum ?? null, maximum: selected?.maximum ?? null,
    difference: priceStatus === BUYBACK_STATUSES[0] ? 0 : selected?.difference ?? null,
    status: uncertain ? 'Perlu diperhatikan' : priceStatus, priceStatus, batch, batchStatus, batchReason, batchRanges, batchEvaluations, batchBasis: 'price',
    reason: `${batchReason} ${batchRanges}`.trim() };
}

function auditBuybackByHeaderTime(tx: BuybackTransaction, references: PriceReference[]): BuybackAuditRow {
  const schedule = headerSchedule(references, tx.date, 'buyback', ['young', 'old']);
  const day = { date: tx.date, fromTime: '00:00', toTime: '24:00', attachmentIds: references.map(ref => ref.id) };
  const base = auditBuybackTransaction(tx, day, references, true);
  const groups = new Map<string, PriceReference[]>();
  for (const ref of references) {
    const key = ref.batch == null ? ref.id : String(ref.batch);
    groups.set(key, [...(groups.get(key) ?? []), ref]);
  }
  const evaluations: BuybackBatchEvaluation[] = [...groups.values()].map(refs => {
    const result = auditBuybackTransaction(tx, day, refs, true);
    return { batch: refs[0].batch ?? null, referenceIds: refs.map(ref => ref.id), reference: result.reference || refs.map(ref => ref.filename).join('; '),
      minimum: result.minimum, maximum: result.maximum, difference: result.difference, status: result.status, reason: result.reason };
  }).sort((a, b) => (a.batch ?? Infinity) - (b.batch ?? Infinity));
  const review = (reason: string): BuybackAuditRow => ({ ...base, minimum: null, maximum: null, difference: null,
    status: 'Perlu diperhatikan', priceStatus: 'Perlu diperhatikan', batch: 'Belum dapat ditentukan', batchStatus: 'Acuan waktu belum dapat ditentukan',
    batchBasis: 'time', batchReason: reason, reason, batchEvaluations: evaluations });
  if (!schedule.valid) return review(schedule.reason);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time)) return review('Jam transaksi tidak tersedia atau tidak valid; batch berdasarkan waktu belum dapat ditentukan.');
  const period = schedule.periods.find(item => inHeaderPeriod(tx.time, item));
  if (!period) return review(`Transaksi pukul ${tx.time} WIB terjadi sebelum acuan pertama berlaku pada ${schedule.periods[0].fromTime} WIB.`);
  const window = { date: tx.date, fromTime: period.fromTime, toTime: period.toTime, attachmentIds: period.refs.map(ref => ref.id) };
  const result = auditBuybackTransaction(tx, window, period.refs);
  const batchReason = `Pukul ${tx.time} WIB masuk Batch ${period.batch}, berlaku ${period.fromTime} sampai ${period.toTime === '24:00' ? 'akhir hari' : `sebelum ${period.toTime}`} WIB.`;
  return { ...result, reference: result.reference || [...new Set(period.refs.map(ref => ref.filename))].join('; '), batch: `Batch ${period.batch}`, assignedBatch: period.batch, batchBasis: 'time', effectiveFrom: period.fromTime, effectiveTo: period.toTime,
    batchStatus: 'Ditentukan dari jam transaksi', batchReason, priceStatus: result.status, batchEvaluations: evaluations,
    reason: `${batchReason} ${result.reason}` };
}
