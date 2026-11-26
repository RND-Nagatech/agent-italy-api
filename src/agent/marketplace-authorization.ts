import type { Db } from 'mongodb';

export type InvoiceAuthorization = {
  status: 'Ada otorisasi' | 'Tidak ditemukan' | 'Belum dapat diperiksa';
  note: string;
  description?: string;
};
export type BelowCostAuthorization = InvoiceAuthorization;

const belowCostDescription = /^\s*PENJUALAN\s+DI\s*BAWAH\s+MODAL\s*$/i;
const aboveNoteDescription = /^\s*PEMBELIAN\s+DI\s*ATAS\s+NOTA\s*$/i;
const invoiceKey = (value: unknown) => typeof value === 'string' && value.trim() !== '-' ? value.trim() : '';
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Read only invoice-linked approvals in this store, without borrowing another authorization type or date. */
export async function readBelowCostAuthorizations(db: Db, invoices: string[]): Promise<Map<string, BelowCostAuthorization>> {
  return readInvoiceAuthorizations(db, invoices, false);
}

export async function readAboveNoteBuybackAuthorizations(db: Db, invoices: string[]): Promise<Map<string, InvoiceAuthorization>> {
  return readInvoiceAuthorizations(db, invoices, true);
}

async function readInvoiceAuthorizations(db: Db, invoices: string[], buyback: boolean): Promise<Map<string, BelowCostAuthorization>> {
  const keys = [...new Set(invoices.map(invoiceKey).filter(Boolean))];
  const result = new Map<string, BelowCostAuthorization>();
  if (!keys.length) return result;
  const kategori = buyback ? 'PEMBELIAN' : 'PENJUALAN';
  const description = buyback ? aboveNoteDescription : belowCostDescription;
  const label = buyback ? 'pembelian di atas nota' : 'penjualan di bawah modal';
  try {
    if (!await db.listCollections({ name: 'tt_authorization' }, { nameOnly: true }).hasNext()) throw new Error('missing collection');
    for (let offset = 0; offset < keys.length; offset += 200) {
      const batch = keys.slice(offset, offset + 200), requested = new Set(batch);
      // PembelianController stores all group invoices in no_faktur.join(',').
      // Match complete comma-separated tokens, never prefixes or a substring.
      const invoiceFilter = buyback ? { $in: [...batch, new RegExp(`(?:^|,)\\s*(?:${batch.map(escapeRegex).join('|')})\\s*(?:,|$)`)] } : { $in: batch };
      const documents = await db.collection('tt_authorization').find({ no_faktur: invoiceFilter, kategori, description },
        { projection: { _id: 1, no_faktur: 1, kategori: 1, description: 1, keterangan: 1, datetime: 1 } })
        .maxTimeMS(5000).sort({ datetime: 1, _id: 1 }).limit(10001).toArray();
      if (documents.length > 10000) throw new Error('authorization result limit');
      const notes = new Map<string, Set<string>>(), descriptions = new Map<string, Set<string>>();
      for (const document of documents) {
        if (document.kategori !== kategori || !description.test(String(document.description ?? ''))) continue;
        const invoicesInRecord = buyback && typeof document.no_faktur === 'string' ? document.no_faktur.split(',').map(invoiceKey) : [invoiceKey(document.no_faktur)];
        const note = typeof document.keterangan === 'string' && document.keterangan.trim() && document.keterangan.trim() !== '-'
          ? document.keterangan.trim() : 'Keterangan tidak diisi';
        for (const invoice of new Set(invoicesInRecord)) {
          if (!requested.has(invoice)) continue;
          const values = notes.get(invoice) ?? new Set<string>();
          values.add(note); notes.set(invoice, values);
          const labels = descriptions.get(invoice) ?? new Set<string>();
          labels.add(String(document.description).trim().replace(/\s+/g, ' ')); descriptions.set(invoice, labels);
        }
      }
      for (const invoice of batch) result.set(invoice, notes.has(invoice)
        ? { status: 'Ada otorisasi', note: [...notes.get(invoice)!].join('\n'), description: [...descriptions.get(invoice)!].join('\n') }
        : { status: 'Tidak ditemukan', note: `Tidak ditemukan otorisasi ${label} untuk faktur ini.` });
    }
  } catch {
    for (const invoice of keys) result.set(invoice, { status: 'Belum dapat diperiksa', note: 'Data otorisasi belum dapat dibaca lengkap; periksa kembali.' });
  }
  return result;
}

export function invoiceAuthorization(invoices: string[], results: Map<string, BelowCostAuthorization>, label = 'penjualan di bawah modal'): BelowCostAuthorization {
  const keys = [...new Set(invoices.map(invoiceKey).filter(Boolean))];
  if (!keys.length) return { status: 'Belum dapat diperiksa', note: 'Nomor faktur belum tersedia untuk memeriksa otorisasi.' };
  const matched = keys.filter(key => results.get(key)?.status === 'Ada otorisasi');
  const unavailable = keys.some(key => !results.has(key) || results.get(key)?.status === 'Belum dapat diperiksa');
  if (matched.length) return {
    status: 'Ada otorisasi',
    description: [...new Set(matched.map(key => results.get(key)!.description).filter(Boolean))].join('\n'),
    note: matched.map(key => `${key}: ${results.get(key)!.note}`).join('\n') + (unavailable ? '\nSebagian faktur belum dapat diperiksa otorisasinya.' : ''),
  };
  return unavailable ? { status: 'Belum dapat diperiksa', note: 'Data otorisasi belum dapat dibaca lengkap; periksa kembali.' }
    : { status: 'Tidak ditemukan', note: `Tidak ditemukan otorisasi ${label} untuk faktur ini.` };
}
