import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from 'mongodb';
import { invoiceAuthorization, readAboveNoteBuybackAuthorizations, readBelowCostAuthorizations } from '../src/agent/marketplace-authorization';

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

test('buyback matches complete invoice tokens in legacy comma-separated authorization records and preserves purchase descriptions', async () => {
  const purchase = (no_faktur: string, keterangan: string, extra = {}) => approval(no_faktur,keterangan,{kategori:'PEMBELIAN',description:'PEMBELIAN DI ATAS\nNOTA',...extra});
  const fixture = store([
    purchase('FB-1, FB-2','Disetujui nominal pembelian'),purchase('FB-1, FB-2','Disetujui nominal pembelian'),
    purchase('FB-20','Faktur yang mirip'),purchase('FB-1','Jenis lain',{description:'PERUBAHAN BERAT'}),
    purchase('FB-1','Kategori lain',{kategori:'PENJUALAN'}),purchase('FB-[1].2','Keterangan kedua'),
  ]);
  const results = await readAboveNoteBuybackAuthorizations(fixture.db,['FB-1','FB-2','FB-3','FB-[1].2']);
  assert.equal(results.get('FB-1')!.status,'Ada otorisasi'); assert.equal(results.get('FB-2')!.status,'Ada otorisasi');
  assert.equal(results.get('FB-2')!.note,'Disetujui nominal pembelian'); assert.equal(results.get('FB-2')!.description,'PEMBELIAN DI ATAS NOTA');
  assert.equal(results.get('FB-3')!.status,'Tidak ditemukan'); assert.match(results.get('FB-3')!.note,/pembelian di atas nota/);
  assert.equal(results.get('FB-[1].2')!.status,'Ada otorisasi');
  const query = fixture.queries[0].query, pattern = query.no_faktur.$in.at(-1);
  assert.equal(query.kategori,'PEMBELIAN'); assert.equal(query.datetime,undefined); assert.equal(query.status_valid,undefined);
  assert.match('PEMBELIAN DI ATAS\nNOTA',query.description);
  assert.match('FB-0, FB-2 ,FB-4',pattern); assert.match('FB-[1].2',pattern);
  assert.doesNotMatch('FB-20',pattern); assert.doesNotMatch('XFB-1',pattern); assert.doesNotMatch('FB-X1Z2',pattern);
  const row = invoiceAuthorization(['FB-2'],results,'pembelian di atas nota');
  assert.equal(row.description,'PEMBELIAN DI ATAS NOTA'); assert.equal(row.note,'FB-2: Disetujui nominal pembelian');
});

test('buyback authorization is isolated by store, handles missing remarks and distinguishes lookup failure', async () => {
  const document = approval('FB-1','-',{kategori:'PEMBELIAN',description:'PEMBELIAN DI ATAS NOTA'});
  const a = await readAboveNoteBuybackAuthorizations(store([document]).db,['FB-1']);
  const b = await readAboveNoteBuybackAuthorizations(store([]).db,['FB-1']);
  assert.equal(a.get('FB-1')!.note,'Keterangan tidak diisi'); assert.equal(a.get('FB-1')!.status,'Ada otorisasi');
  assert.equal(b.get('FB-1')!.status,'Tidak ditemukan');
  for (const fixture of [store([],true),store([],false,false)]) {
    const unavailable = await readAboveNoteBuybackAuthorizations(fixture.db,['FB-1']);
    assert.equal(invoiceAuthorization(['FB-1'],unavailable,'pembelian di atas nota').status,'Belum dapat diperiksa');
  }
});

test('authorization invoice lookups stay bounded across more than 200 requested invoices', async () => {
  const fixture = store([]), invoices = Array.from({length:201},(_,index)=>`FB-${index}`);
  const results = await readAboveNoteBuybackAuthorizations(fixture.db,invoices);
  assert.equal(results.size,201); assert.equal(fixture.queries.length,2);
  assert.equal(fixture.queries[0].query.no_faktur.$in.length,201); assert.equal(fixture.queries[1].query.no_faktur.$in.length,2);
});
