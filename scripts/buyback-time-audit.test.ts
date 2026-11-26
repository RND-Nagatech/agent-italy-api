import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBuybackBatches, type BuybackTransaction } from '../src/agent/buyback-audit.logic';
import { buybackReportTable } from '../src/agent/buyback-report.logic';
import { headerSchedule, priceReferenceParts } from '../src/agent/price-reference-periods';
import type { PriceReference, PriceRule } from '../src/agent/price-audit.logic';

const date = '2026-11-23';
const rule = (family: PriceRule['family'], sourceCode: string, condition: PriceRule['condition'], rate: number, maxRate: number | null = null): PriceRule => ({ family, sourceCode, condition, rate, maxRate, kind: 'buyback', sourceRow: sourceCode, kadar: null, fee: null, feeType: 'unknown', note: '' });
const reference = (batch: number, family: PriceRule['family'], effectiveFrom: string | null): PriceReference => ({
  id: `${family}-${batch}`, filename: `${family}-${batch}.jpeg`, date, batch, effectiveFrom, complete: true, warnings: [],
  rows: family === 'young' ? [rule('young', 'H04', 'GOOD', batch === 1 ? 790000 : 795000)] : [rule('old', 'D7', 'GOOD', batch === 1 ? 1533000 : 1544000), rule('old', 'D7', 'STONE', batch === 1 ? 1491000 : 1502000, batch === 1 ? 1523000 : 1533000)],
});
const refs = [reference(2, 'old', '12:00'), reference(1, 'young', '07:00'), reference(1, 'old', '07:00'), reference(2, 'young', '12:00')];
const tx = (time: string, pricePerGram: number | null = 790000, internalCode = 'H04'): BuybackTransaction => ({ id: 'one', kind: 'buyback', date, time, pricePerGram, internalCode,
  store: 'Italy Pusat', invoice: 'B-1', name: 'Cincin', barcode: '001234', kadar: null, printedKadar: '', weight: 1.71, price: null, fee: null, quantity: 1, condition: 'CUCI 8K / 9K', inputBy: 'Kasir' });

test('printed header starts define exclusive transitions, independent of upload order', () => {
  const schedule = headerSchedule(refs, date);
  assert.equal(schedule.valid, true);
  assert.deepEqual(schedule.periods.map(row => [row.batch, row.fromTime, row.toTime]), [[1, '07:00', '12:00'], [2, '12:00', '24:00']]);
  for (const [time, batch] of [['07:00:00', 1], ['11:59:59', 1], ['12:00:00', 2], ['23:59:59', 2]] as const) assert.equal(auditBuybackBatches(tx(time), refs).assignedBatch, batch);
  const early = auditBuybackBatches(tx('06:59:59'), refs);
  assert.equal(early.assignedBatch, undefined); assert.equal(early.status, 'Perlu diperhatikan'); assert.match(early.reason, /sebelum.*07:00/);
});

test('effective hours are dynamic data: 08:15, 13:40 and 17:05 are not special-cased', () => {
  const dynamic = [reference(2, 'young', '13:40'), reference(1, 'young', '08:15'), reference(3, 'young', '17:05')];
  for (const [time, batch] of [['08:15:00', 1], ['13:39:59', 1], ['13:40:00', 2], ['17:04:59', 2], ['17:05:00', 3], ['23:59:59', 3]] as const) assert.equal(auditBuybackBatches(tx(time), dynamic).assignedBatch, batch);
  assert.deepEqual(headerSchedule(dynamic, date).periods.map(row => [row.fromTime, row.toTime]), [['08:15', '13:40'], ['13:40', '17:05'], ['17:05', '24:00']]);
});

test('a wrong price remains attached to its time batch rather than switching to a matching-price batch', () => {
  const result = auditBuybackBatches(tx('13:00:00', 790000), refs);
  assert.equal(result.batch, 'Batch 2'); assert.equal(result.batchBasis, 'time');
  assert.equal(result.status, 'Di luar range acuan'); assert.equal(result.priceStatus, 'Di luar range acuan');
  assert.equal(result.minimum, 795000); assert.equal(result.difference, -5000);
  assert.match(result.reason, /Pukul 13:00:00 WIB masuk Batch 2/); assert.match(result.reason, /5\.000/);
  const before = auditBuybackBatches(tx('11:59:59', 795000), refs);
  assert.equal(before.batch, 'Batch 1'); assert.equal(before.status, 'Di luar range acuan');
});

test('overlapping CUCI ranges and identical prices still resolve to exactly the time batch', () => {
  for (const [time, batch] of [['08:00:00', 1], ['13:00:00', 2]] as const) {
    const result = auditBuybackBatches({ ...tx(time, 1507874, 'D7'), condition: 'CUCI 16K / 17K' }, refs);
    assert.equal(result.batch, `Batch ${batch}`); assert.equal(result.status, 'Masih dalam batas range acuan');
    assert.equal(result.batchStatus, 'Ditentukan dari jam transaksi');
  }
  const samePrice = refs.map(ref => ref.id === 'young-2' ? { ...ref, rows: [rule('young', 'H04', 'GOOD', 790000)] } : ref);
  assert.equal(auditBuybackBatches(tx('13:00:00'), samePrice).batch, 'Batch 2');
});

test('missing transaction times and partial/conflicting header schedules never fall back to price inference', () => {
  for (const time of ['', 'not-a-time', '24:00:00']) {
    const result = auditBuybackBatches(tx(time), refs);
    assert.equal(result.status, 'Perlu diperhatikan'); assert.equal(result.assignedBatch, undefined); assert.match(result.reason, /Jam transaksi/);
  }
  const schedules = [
    refs.map(ref => ref.id === 'old-2' ? { ...ref, effectiveFrom: null } : ref),
    refs.map(ref => ref.id === 'old-1' ? { ...ref, effectiveFrom: '08:00' } : ref),
    refs.map(ref => ref.batch === 2 ? { ...ref, effectiveFrom: '07:00' } : ref),
    refs.map(ref => ref.id === 'young-1' ? { ...ref, batch: null } : ref),
    refs.map(ref => ref.id === 'young-1' ? { ...ref, effectiveFrom: '25:00' } : ref),
  ];
  for (const schedule of schedules) {
    const result = auditBuybackBatches(tx('08:00:00'), schedule);
    assert.equal(result.batchBasis, 'time'); assert.equal(result.assignedBatch, undefined); assert.equal(result.status, 'Perlu diperhatikan');
    assert.ok(result.batchEvaluations!.some(row => row.status === 'Masih dalam batas range acuan'), 'a matching price does not override incomplete time metadata');
  }
});

test('valid time assignment survives missing masters or missing prices, with price verification kept unverified', () => {
  for (const purchase of [{ ...tx('08:00:00', 1480000, '-'), lookupNote: 'Barang tidak ditemukan di tm_barang.' }, tx('08:00:00', null)]) {
    const result = auditBuybackBatches(purchase, refs);
    assert.equal(result.batch, 'Batch 1'); assert.equal(result.status, 'Perlu diperhatikan'); assert.equal(result.assignedBatch, 1);
  }
  const incomplete = refs.map(ref => ref.id === 'young-1' ? { ...ref, complete: false } : ref);
  assert.equal(auditBuybackBatches(tx('08:00:00'), incomplete).batch, 'Batch 1');
  assert.equal(auditBuybackBatches(tx('08:00:00'), incomplete).status, 'Perlu diperhatikan');
});

test('two independent batch panels in one attachment keep their own hours and prices', () => {
  const sections = [reference(1, 'young', '07:00'), reference(2, 'young', '12:00')];
  const combined: PriceReference = { ...sections[0], id: 'combined', filename: 'two-panels.jpeg', batch: null, effectiveFrom: null, sections, rows: sections.flatMap(section => section.rows) };
  assert.equal(priceReferenceParts([combined]).length, 2);
  assert.equal(auditBuybackBatches(tx('11:59:59', 790000), [combined]).batch, 'Batch 1');
  assert.equal(auditBuybackBatches(tx('12:00:00', 795000), [combined]).batch, 'Batch 2');
  const table = buybackReportTable([auditBuybackBatches(tx('13:00:00', 790000), [combined])], [combined], true);
  const cell = (name: string) => table.rows[0][table.columns.indexOf(name)];
  assert.equal(cell('Batch Acuan'), 'Batch 2'); assert.equal(cell('Dasar Penentuan Batch'), 'Jam transaksi');
  assert.equal(cell('Berlaku WIB'), '12:00–akhir hari'); assert.equal(cell('Hasil Pemeriksaan'), 'Di luar range acuan');
  assert.equal(cell('Range Batch 1 (IDR/gram)'), 'Rp790.000 (harga tunggal)');
  assert.equal(cell('Range Batch 2 (IDR/gram)'), 'Rp795.000 (harga tunggal)');
  assert.equal(cell('Keterangan Pemeriksaan'), 'Pukul 13:00:00 WIB masuk Batch 2. Harga buyback lebih rendah Rp5.000 dari batas bawah acuan Batch 2.');
  assert.equal(table.rows[0].length, table.columns.length);
});

test('files without hours retain price-based mode and other dates cannot change a daily schedule', () => {
  const untimed = refs.map(ref => ({ ...ref, effectiveFrom: null }));
  assert.equal(auditBuybackBatches(tx('', 795000), untimed).batch, 'Batch 2');
  assert.equal(auditBuybackBatches(tx('', 795000), untimed).batchBasis, 'price');
  const otherDay = { ...reference(1, 'young', '06:00'), date: '2026-11-24' };
  assert.equal(auditBuybackBatches(tx('11:59:59'), [...refs, otherDay]).batch, 'Batch 1');
});
