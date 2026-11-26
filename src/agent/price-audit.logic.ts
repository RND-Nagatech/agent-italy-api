export type PriceKind = 'sales' | 'buyback';
export type PriceFamily = 'young' | 'old';
export type PriceRule = {
  family: PriceFamily; kind: PriceKind; kadar: number | null; sourceCode: string;
  rate: number; maxRate: number | null; fee: number | null; feeType: 'nominal' | 'percent' | 'unknown';
  condition: 'ANY' | 'GOOD' | 'SCRAP' | 'STONE' | 'DAMAGED_8' | 'DAMAGED_9';
  note: string;
  sourceRow?: string; printedKadar?: string; sourceLabel?: string;
};
export type PriceReferenceSection = { date: string; batch?: number | null; effectiveFrom?: string | null; complete: boolean; warnings: string[]; rows: PriceRule[] };
export type PriceReference = PriceReferenceSection & { id: string; filename: string; sections?: PriceReferenceSection[] };
export type PriceWindow = { date: string; fromTime: string; toTime: string; attachmentIds: string[] };
export type AuditTransaction = {
  id: string; kind: PriceKind; store: string; date: string; time: string; invoice: string;
  name: string; kadar: number | null; weight: number | null; price: number | null; pricePerGram: number | null;
  invoicePrice?: number | null;
  marketplace?: string; invoiceGroup?: string; overpayment?: number | null;
  belowCostAuthorization?: import('./marketplace-authorization').BelowCostAuthorization;
  aboveNoteAuthorization?: import('./marketplace-authorization').InvoiceAuthorization;
  fee: number | null; quantity: number; condition: string; inputBy: string;
  barcode?: string; kadarSource?: string; kadarNote?: string;
  internalCode?: string; printedKadar?: string; lookupNote?: string; masterSource?: 'MongoDB' | 'MariaDB (RDS)';
};
export type PriceAuditRow = AuditTransaction & {
  window: string; reference: string; expectedRate: number | null; actualRate: number | null;
  expectedFee: number | null; expectedFeeUnrounded: number | null; billedWeight: number | null; priceDifference: number | null; feeDifference: number | null;
  referenceKadar: number | null;
  priceStatus: 'Cocok' | 'Tidak cocok' | 'Belum dapat diperiksa';
  feeStatus: 'Cocok' | 'Tidak cocok' | 'Belum dapat diperiksa';
  status: 'Cocok' | 'Tidak cocok' | 'Belum dapat diperiksa'; reason: string;
  code?: string; batch?: string; batchStatus?: string; batchReason?: string; batchRates?: string;
  batchPrices?: Array<{ batch: number | null; rate: number | null; difference: number | null; note: string }>;
};
export const validPriceDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const validPriceTime = (value: string, end = false) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) || (end && value === '24:00');
export function validatePriceWindows(windows: PriceWindow[]): string | null {
  if (!windows.length || windows.length > 8) return 'Isi 1–8 acuan pemeriksaan.';
  for (const w of windows) {
    if (!validPriceDate(w.date) || !validPriceTime(w.fromTime) || !validPriceTime(w.toTime, true) || w.fromTime >= w.toTime) return 'Tanggal/jam acuan tidak valid. Jam selesai harus sesudah jam mulai (WIB).';
    if (!w.attachmentIds.length || w.attachmentIds.length > 8 || new Set(w.attachmentIds).size !== w.attachmentIds.length) return 'Setiap acuan memerlukan 1–8 file yang berbeda.';
  }
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    const a = windows[i], b = windows[j];
    if (a.date === b.date && a.fromTime < b.toTime && b.fromTime < a.toTime) return 'Rentang waktu acuan bertumpuk. Pisahkan rentangnya agar setiap transaksi diperiksa sekali.';
  }
  return null;
}

// Legacy grade resolver. Automatic code audits filter by the master code first.
export function resolveReferenceKadar(references: PriceReference[]): Array<PriceRule & { reference: string; complete: boolean }> {
  const kadarByCode = new Map<string, Set<number>>();
  for (const ref of references) for (const row of ref.rows) {
    if (row.kind !== 'sales' || row.kadar === null || !row.sourceCode) continue;
    const key = `${row.family}:${row.sourceCode.toUpperCase()}`;
    const values = kadarByCode.get(key) ?? new Set<number>(); values.add(row.kadar); kadarByCode.set(key, values);
  }
  return references.flatMap(ref => ref.rows.map(row => {
    const codes = row.sourceCode.toUpperCase().split(/\s*[/,]\s*/).filter(Boolean);
    const sets = codes.map(code => kadarByCode.get(`${row.family}:${code}`));
    const values = sets.length && sets.every(set => set?.size === 1) ? new Set(sets.flatMap(set => [...set!])) : undefined;
    return { ...row, kadar: row.kadar ?? (values?.size === 1 ? [...values][0] : null), reference: ref.filename, complete: ref.complete };
  }));
}

export function purchaseCondition(value: string): PriceRule['condition'] | null {
  const text = value.toUpperCase();
  if (/RUSAK/.test(text)) {
    const eight = /\b8\s*K\b/.test(text), nine = /\b9\s*K\b/.test(text);
    if (eight !== nine) return eight ? 'DAMAGED_8' : 'DAMAGED_9';
    if (eight || nine) return null;
    return 'SCRAP';
  }
  if (/ANCUR|HANCUR|LUAR\s*TOKO|RONGSOK|RUSAK/.test(text)) return 'SCRAP';
  if (/MATA|JELEK|CAP/.test(text)) return 'STONE';
  if (/BAGUS|BAIK|NORMAL|\bCUCI\b/.test(text)) return 'GOOD';
  return null;
}

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export function moneyWeight(rate: number, weight: number) {
  // Decimal money × up to six decimal places of grams, without binary float accumulation.
  return Number(BigInt(Math.round(rate * 100)) * BigInt(Math.round(weight * 1_000_000)) / 1_000_000n) / 100;
}

export function roundedPerGramFee(rate: number, weight: number, quantity = 1): { raw: number; rounded: number; billedWeight: number } | null {
  if (!Number.isFinite(rate) || rate < 0 || !Number.isFinite(weight) || weight <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
  const cents = Math.round(rate * 100), microGrams = Math.round(weight * 1_000_000);
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(microGrams) || microGrams <= 0) return null;
  // Charge each item's weight in whole grams, rounding upward before applying
  // its per-gram fee. Quantity multiplies the individually rounded weight.
  const billedWeight = Math.ceil(weight) * quantity;
  if (!Number.isSafeInteger(billedWeight)) return null;
  const product = BigInt(cents) * BigInt(microGrams) * BigInt(quantity);
  const billedCents = Number(BigInt(cents) * BigInt(billedWeight));
  return Number.isSafeInteger(billedCents) ? { raw: Number(product) / 100_000_000, rounded: billedCents / 100, billedWeight } : null;
}

export function auditPriceTransaction(tx: AuditTransaction, window: PriceWindow | undefined, refs: PriceReference[], tolerance = 0, fullDay = false): PriceAuditRow {
  const result: PriceAuditRow = { ...tx, window: window ? `${window.date} ${window.fromTime}–${window.toTime} WIB` : 'Jam belum terbaca', reference: '', expectedRate: null, actualRate: tx.kind === 'sales' ? tx.pricePerGram : null, expectedFee: null, expectedFeeUnrounded: null, billedWeight: null, priceDifference: null, feeDifference: null, referenceKadar: null, priceStatus: 'Belum dapat diperiksa', feeStatus: 'Belum dapat diperiksa', status: 'Belum dapat diperiksa', reason: '' };
  const review = (reason: string) => ({ ...result, reason });
  if (tx.kind === 'buyback') return review('Pemeriksaan buyback memakai harga_rata dan kode intern master barang; gunakan alur buyback.');
  if (fullDay && window) result.window = `${window.date} sehari penuh WIB`;
  if (!window || (!fullDay && !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(tx.time))) return review('Jam transaksi tidak tersedia/valid; acuan waktu belum dapat dipilih.');
  if (tx.date !== window.date || (!fullDay && (tx.time.slice(0, 5) < window.fromTime || tx.time.slice(0, 5) >= window.toTime))) return review('Transaksi berada di luar tanggal/jam acuan yang dipilih.');
  if (tx.kadar === null || !Number.isFinite(tx.kadar)) return review(tx.kadarNote || 'Kadar barang pada detail transaksi belum tersedia.');
  if (tx.kind === 'sales') {
    if (tx.pricePerGram === null || tx.pricePerGram === undefined || !Number.isFinite(tx.pricePerGram) || tx.pricePerGram <= 0) return review('Harga per gram pada transaksi (harga_gram) belum tersedia/valid. Harga tidak dihitung ulang dari nominal total.');
  }
  const resolvedRules = resolveReferenceKadar(refs);
  let rules = resolvedRules.filter(row => row.kind === tx.kind && row.kadar === tx.kadar);
  let expectedKadarMismatch: number | null = null;
  if (tx.kind === 'sales') {
    // Use the stored transaction price per gram directly; total-price rounding
    // must never change the price used to identify the reference grade.
    const nominalMatches = resolvedRules.filter(row => {
      if (row.kind !== 'sales' || row.kadar === null || !row.complete) return false;
      return Math.abs(row.rate - tx.pricePerGram!) <= tolerance;
    });
    const matchedGrades = [...new Set(nominalMatches.map(row => row.kadar!))];
    if (!matchedGrades.includes(tx.kadar)) {
      if (matchedGrades.length === 1) {
        expectedKadarMismatch = matchedGrades[0];
        rules = nominalMatches;
      } else if (matchedGrades.length > 1) {
        return review(`Harga per gram transaksi sesuai beberapa kadar (${matchedGrades.join(', ')}), sedangkan kadar faktur ${tx.kadar}. Kadar acuan belum dapat dipastikan.`);
      }
    }
  }
  if (!rules.length) {
    const family = tx.kadar <= 60 ? 'young' : 'old';
    const familyRules = resolvedRules.filter(row => row.kind === tx.kind && row.family === family);
    return review(!familyRules.length
      ? `Belum ada file ${tx.kind === 'sales' ? 'harga penjualan' : 'buyback'} emas ${family === 'young' ? 'muda 8K/9K' : 'tua'} pada acuan waktu ini. Lampirkan file terkait pada acuan yang sama.`
      : familyRules.some(row => row.kadar === null)
        ? `Kadar ${tx.kadar} belum dapat dipetakan ke tarif file. Lampirkan file penjualan pendamping atau lengkapi kadar acuan yang belum jelas; kadar tidak ditebak dari urutan/kode.`
        : `Tidak ditemukan acuan dengan kadar ${tx.kadar} yang sama. Kadar desimal tidak dibulatkan atau diganti otomatis.`);
  }
  const candidates = rules;
  result.reference = [...new Set(candidates.map(row => row.reference))].join('; ');
  if (candidates.some(row => !row.complete)) return review('Hasil pembacaan file terkait belum lengkap; periksa file acuan.');
  const prices = [...new Set(candidates.map(row => `${row.rate}:${row.maxRate ?? row.rate}`))];
  if (prices.length !== 1) return review('Terdapat beberapa harga acuan berbeda untuk kadar yang sama. Perbaiki acuan agar tarifnya tunggal.');
  const rule = candidates[0];
  result.expectedRate = rule.rate;
  result.referenceKadar = rule.kadar;
  const maxRate = rule.maxRate ?? rule.rate;
  const priceDifference = result.actualRate! < rule.rate ? result.actualRate! - rule.rate : result.actualRate! > maxRate ? result.actualRate! - maxRate : 0;
  result.priceDifference = round(priceDifference);
  const problems: string[] = [];
  const incomplete: string[] = [];
  const calculations: string[] = [];
  const idr = (n: number) => `Rp${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(Math.abs(n))}`;
  if (expectedKadarMismatch !== null) problems.push(`Harga per gram ${idr(result.actualRate!)} sesuai acuan kadar ${expectedKadarMismatch}, tetapi kadar barang ${tx.kadarSource === 'Master barang (barcode)' ? 'dari master barang' : 'pada detail faktur'} adalah ${tx.kadar}; periksa kesesuaian barang/faktur.`);
  if (Math.abs(priceDifference) > tolerance) problems.push(`Harga ${tx.kind === 'sales' ? 'jual' : 'buyback'} per gram lebih ${priceDifference < 0 ? 'rendah' : 'tinggi'} ${idr(priceDifference)}; acuan ${idr(rule.rate)}${maxRate !== rule.rate ? `–${idr(maxRate)}` : ''}/gram, transaksi ${idr(result.actualRate!)}/gram. Ongkos tidak termasuk harga emas per gram.`);
  result.priceStatus = problems.length ? 'Tidak cocok' : 'Cocok';
  if (result.priceStatus === 'Cocok') calculations.push(`Harga per gram ${idr(result.actualRate!)} dan kadar barang ${tx.kadar} cocok dengan acuan.`);
  if (tx.kind === 'sales') {
    const fees = [...new Set(candidates.map(row => `${row.feeType}:${row.fee}`))];
    if (fees.length !== 1) incomplete.push('Ongkos acuan untuk kadar yang sama berbeda; belum ada satu ongkos baku.');
    else if (rule.feeType !== 'nominal' || rule.fee === null) incomplete.push(rule.feeType === 'percent' ? 'Dasar ongkos/potongan persen belum ditetapkan.' : 'Ongkos tidak tercantum; sel kosong tidak dianggap nol.');
    else if (tx.fee === null || !Number.isFinite(tx.fee)) incomplete.push('Ongkos transaksi belum tersedia.');
    else if (tx.weight === null || !Number.isFinite(tx.weight) || tx.weight <= 0 || !Number.isSafeInteger(tx.quantity) || tx.quantity <= 0) incomplete.push('Berat atau jumlah transaksi belum valid untuk menghitung ongkos.');
    else {
      const fee = roundedPerGramFee(rule.fee, tx.weight, tx.quantity);
      if (!fee) incomplete.push('Tarif, berat, atau jumlah di luar rentang perhitungan ongkos.');
      else {
        result.expectedFeeUnrounded = fee.raw;
        result.expectedFee = fee.rounded;
        result.billedWeight = fee.billedWeight;
        result.feeDifference = round(tx.fee - result.expectedFee);
        result.feeStatus = Math.abs(result.feeDifference) > tolerance ? 'Tidak cocok' : 'Cocok';
        const grams = (n: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(n);
        calculations.push(`Berat ${grams(tx.weight)} gram dibulatkan ke atas menjadi ${grams(Math.ceil(tx.weight))} gram per barang. Ongkos ${idr(rule.fee)}/gram × ${grams(Math.ceil(tx.weight))} gram${tx.quantity > 1 ? ` × ${tx.quantity} barang` : ''} = ${idr(fee.rounded)}.`);
        if (Math.abs(result.feeDifference) > tolerance) problems.push(`Ongkos lebih ${result.feeDifference < 0 ? 'rendah' : 'tinggi'} ${idr(result.feeDifference)}; acuan ${idr(result.expectedFee)}, transaksi ${idr(tx.fee)}.`);
      }
    }
  }
  result.status = problems.length ? 'Tidak cocok' : incomplete.length ? 'Belum dapat diperiksa' : 'Cocok';
  result.reason = [...problems, ...incomplete, ...calculations].join(' ');
  if (result.status === 'Cocok') result.reason = `Harga ${tx.kind === 'sales' ? 'jual dan ongkos' : 'buyback sesuai kondisi'} cocok dengan acuan kadar ${tx.kadar}. ${result.reason}`.trim();
  return result;
}
