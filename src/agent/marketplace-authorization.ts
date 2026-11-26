import type { Db } from 'mongodb';

export type BelowCostAuthorization = {
  status: 'Ada otorisasi' | 'Tidak ditemukan' | 'Belum dapat diperiksa';
  note: string;
};

const belowCostDescription = /^\s*PENJUALAN\s+DI\s*BAWAH\s+MODAL\s*$/i;
const invoiceKey = (value: unknown) => typeof value === 'string' && value.trim() !== '-' ? value.trim() : '';

/** Read only invoice-linked approvals in this store, without borrowing another authorization type or date. */
export async function readBelowCostAuthorizations(db: Db, invoices: string[]): Promise<Map<string, BelowCostAuthorization>> {
  const keys = [...new Set(invoices.map(invoiceKey).filter(Boolean))];
  const result = new Map<string, BelowCostAuthorization>();
  if (!keys.length) return result;
  const requested = new Set(keys);
  try {
    if (!await db.listCollections({ name: 'tt_authorization' }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
    const documents = await db.collection('tt_authorization').find({
      no_faktur: { $in: keys }, kategori: 'PENJUALAN', description: belowCostDescription,
    }, { projection: { _id: 1, no_faktur: 1, kategori: 1, description: 1, keterangan: 1, datetime: 1 } })
      .maxTimeMS(5000).sort({ datetime: 1, _id: 1 }).limit(10001).toArray();
    if (documents.length > 10000) throw new Error('authorization result limit');
    const notes = new Map<string, Set<string>>();
    for (const document of documents) {
      const invoice = invoiceKey(document.no_faktur);
      if (!requested.has(invoice) || document.kategori !== 'PENJUALAN' || !belowCostDescription.test(String(document.description ?? ''))) continue;
      const note = typeof document.keterangan === 'string' && document.keterangan.trim() && document.keterangan.trim() !== '-'
        ? document.keterangan.trim() : 'Keterangan tidak diisi';
      const values = notes.get(invoice) ?? new Set<string>();
      values.add(note); notes.set(invoice, values);
    }
    for (const invoice of keys) result.set(invoice, notes.has(invoice)
      ? { status: 'Ada otorisasi', note: [...notes.get(invoice)!].join('\n') }
      : { status: 'Tidak ditemukan', note: 'Tidak ditemukan otorisasi penjualan di bawah modal untuk faktur ini.' });
  } catch {
    for (const invoice of keys) result.set(invoice, { status: 'Belum dapat diperiksa', note: 'Data otorisasi belum dapat dibaca lengkap; periksa kembali.' });
  }
  return result;
}

export function invoiceAuthorization(invoices: string[], results: Map<string, BelowCostAuthorization>): BelowCostAuthorization {
  const keys = [...new Set(invoices.map(invoiceKey).filter(Boolean))];
  if (!keys.length) return { status: 'Belum dapat diperiksa', note: 'Nomor faktur belum tersedia untuk memeriksa otorisasi.' };
  const matched = keys.filter(key => results.get(key)?.status === 'Ada otorisasi');
  const unavailable = keys.some(key => !results.has(key) || results.get(key)?.status === 'Belum dapat diperiksa');
  if (matched.length) return {
    status: 'Ada otorisasi',
    note: matched.map(key => `${key}: ${results.get(key)!.note}`).join('\n') + (unavailable ? '\nSebagian faktur belum dapat diperiksa otorisasinya.' : ''),
  };
  return unavailable ? { status: 'Belum dapat diperiksa', note: 'Data otorisasi belum dapat dibaca lengkap; periksa kembali.' }
    : { status: 'Tidak ditemukan', note: 'Tidak ditemukan otorisasi penjualan di bawah modal untuk faktur ini.' };
}
