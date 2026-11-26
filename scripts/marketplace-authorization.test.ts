import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from 'mongodb';
import { invoiceAuthorization, readBelowCostAuthorizations } from '../src/agent/marketplace-authorization';

const approval = (no_faktur: string, keterangan: string, extra = {}) => ({ no_faktur, kategori: 'PENJUALAN', description: 'PENJUALAN DI BAWAH MODAL', keterangan, ...extra });
function store(documents: object[], fail = false, exists = true) {
  const queries: any[] = [];
  const db = { listCollections: () => ({ hasNext: async () => exists }), collection: (name: string) => {
    assert.equal(name, 'tt_authorization');
    return { find: (query: object, options: object) => {
      queries.push({ query, options });
      const cursor = { maxTimeMS(ms: number) { assert.equal(ms, 5000); return this; }, sort() { return this; }, limit() { return this; }, async toArray() { if (fail) throw new Error('offline'); return documents; } };
      return cursor;
    } };
  } } as unknown as Db;
  return { db, queries };
}

test('only the exact invoice and below-cost sales authorization qualify; notes are deduplicated without multiplying transactions', async () => {
  const fixture = store([
    approval('FJ-1','Disetujui mengikuti harga marketplace'), approval('FJ-1','Disetujui mengikuti harga marketplace'), approval('FJ-1','Persetujuan tambahan'),
    approval('FJ-1','Ubah berat',{description:'PERUBAHAN BERAT'}), approval('FJ-1','Bukan penjualan',{kategori:'PEMBELIAN'}), approval('FJ-10','Faktur lain'),
  ]);
  const results = await readBelowCostAuthorizations(fixture.db,['FJ-1','FJ-2','FJ-1']);
  assert.equal(results.size,2); assert.equal(results.get('FJ-1')!.status,'Ada otorisasi');
  assert.equal(results.get('FJ-1')!.note,'Disetujui mengikuti harga marketplace\nPersetujuan tambahan');
  assert.equal(results.get('FJ-2')!.status,'Tidak ditemukan');
  const query = fixture.queries[0].query;
  assert.deepEqual(query.no_faktur,{$in:['FJ-1','FJ-2']}); assert.equal(query.kategori,'PENJUALAN');
  assert.equal(query.datetime,undefined,'approval may precede the sale/report period');
  assert.equal(query.status_valid,undefined,'tt_authorization has no sales status');
  assert.match('PENJUALAN DI BAWAH MODAL',query.description);
  assert.doesNotMatch('PENJUALAN DI BAWAH HARGA JUAL',query.description);
});

test('same invoice in another store does not inherit approval; absent notes stay explicit', async () => {
  const a = await readBelowCostAuthorizations(store([approval('FJ-1','-')]).db,['FJ-1']);
  const b = await readBelowCostAuthorizations(store([]).db,['FJ-1']);
  assert.equal(a.get('FJ-1')!.status,'Ada otorisasi'); assert.equal(a.get('FJ-1')!.note,'Keterangan tidak diisi');
  assert.equal(b.get('FJ-1')!.status,'Tidak ditemukan');
});

test('grouped marketplace reports identify the approved item invoice, even when it is not the primary invoice', async () => {
  const results = await readBelowCostAuthorizations(store([approval('FJ-2','Disetujui oleh supervisor')]).db,['FJ-1','FJ-2','PACKING']);
  const group = invoiceAuthorization(['FJ-1','FJ-2'],results);
  assert.equal(group.status,'Ada otorisasi'); assert.equal(group.note,'FJ-2: Disetujui oleh supervisor');
  assert.equal(invoiceAuthorization(['FJ-1'],results).status,'Tidak ditemukan');
  assert.equal(invoiceAuthorization([],results).status,'Belum dapat diperiksa');
});

test('missing collection, failed reads and capped results never imply that no authorization exists', async () => {
  for (const fixture of [store([],true),store([],false,false),store(Array.from({length:10001},()=>approval('FJ-1','Approved')))]) {
    const results = await readBelowCostAuthorizations(fixture.db,['FJ-1']);
    assert.equal(results.get('FJ-1')!.status,'Belum dapat diperiksa');
    assert.equal(invoiceAuthorization(['FJ-1'],results).status,'Belum dapat diperiksa');
  }
});
