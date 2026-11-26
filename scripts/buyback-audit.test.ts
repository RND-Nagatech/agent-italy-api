import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBuybackTransaction, auditBuybackBatches, buybackCode, type BuybackTransaction } from '../src/agent/buyback-audit.logic';
import { priceAuditScope } from '../src/agent/price-audit-scope';
import type { PriceReference, PriceRule } from '../src/agent/price-audit.logic';
import { buybackReportTable } from '../src/agent/buyback-report.logic';

const window = { date: '2026-11-20', fromTime: '09:00', toTime: '11:00', attachmentIds: ['one'] };
const tx: BuybackTransaction = { id: '1', kind: 'buyback', store: 'Italy Pusat', date: window.date, time: '10:59:59', invoice: 'B1', name: 'Cincin', kadar: null, weight: 2, price: 9999999, pricePerGram: 1800000, fee: null, quantity: 1, condition: 'CUCI 16K / 17K RP', inputBy: 'Kasir', internalCode: 'D3 16', printedKadar: '' };
const rule = (condition: PriceRule['condition'], rate: number, maxRate: number | null = null): PriceRule => ({ family: 'old', kind: 'buyback', kadar: null, sourceCode: 'D3', sourceRow: 'left:30', rate, maxRate, condition, fee: null, feeType: 'unknown', note: '' });
const rules = [rule('GOOD', 1808000), rule('SCRAP', 1716000), rule('STONE', 1757000, 1788000)];
const ref = (rows = rules, complete = true): PriceReference => ({ id: 'one', filename: 'buyback.png', date: window.date, complete, warnings: [], rows });

test('buyback codes preserve two/three characters and leading zeroes', () => {
  for (const [value, code] of [['c5 16', 'C5'], ['C10 17', 'C10'], ['D13-OLD', 'D13'], ['H04 8', 'H04']]) assert.equal(buybackCode(value), code);
  for (const value of ['-', '', 'text C5']) assert.equal(buybackCode(value), '');
  assert.equal(buybackCode('C516', ['C5', 'C1', 'C10']), 'C5');
  assert.equal(buybackCode('C1016', ['C1', 'C10']), 'C10');
  assert.equal(buybackCode('H0412', ['H04', 'H10']), 'H04');
});
test('CUCI D3 uses the smallest non-scrap price through the largest, inclusive, directly from harga_rata', () => {
  for (const rate of [1757000, 1788000, 1800000, 1808000]) {
    const result = auditBuybackTransaction({ ...tx, pricePerGram: rate }, window, [ref()]);
    assert.equal(result.status, 'Masih dalam batas range acuan'); assert.equal(result.minimum, 1757000); assert.equal(result.maximum, 1808000); assert.equal(result.difference, 0);
    assert.match(result.reason, /termasuk kedua batas/);
  }
  const low = auditBuybackTransaction({ ...tx, pricePerGram: 1750000 }, window, [ref()]);
  assert.equal(low.status, 'Di luar range acuan'); assert.equal(low.difference, -7000); assert.match(low.reason, /batas bawah.*7\.000/);
  const high = auditBuybackTransaction({ ...tx, pricePerGram: 1820000 }, window, [ref()]);
  assert.equal(high.difference, 12000); assert.match(high.reason, /batas atas.*12\.000/);
  assert.equal(auditBuybackTransaction({ ...tx, pricePerGram: 1716000 }, window, [ref()]).status, 'Di luar range acuan', 'the ancuran tariff never lowers a CUCI range');
});
test('no rounding, grade requirement, total/weight derivation or extra deductions', () => {
  assert.equal(auditBuybackTransaction({ ...tx, price: null, weight: null, kadar: null }, window, [ref()]).status, 'Masih dalam batas range acuan');
  assert.equal(auditBuybackTransaction({ ...tx, pricePerGram: 1808000.01 }, window, [ref()]).status, 'Di luar range acuan');
  assert.equal(auditBuybackTransaction({ ...tx, pricePerGram: null }, window, [ref()]).status, 'Perlu diperhatikan');
  const c5 = rules.map(row => ({ ...row, sourceCode: 'C5', rate: row.condition === 'GOOD' ? 1500000 : row.condition === 'STONE' ? 1459000 : 1418000, maxRate: row.condition === 'STONE' ? 1490000 : null }));
  assert.equal(auditBuybackTransaction({ ...tx, internalCode: 'C5 16', pricePerGram: 1500000 }, window, [ref(c5)]).status, 'Masih dalam batas range acuan');
});
test('RUSAK selects the scrap tariff as a point interval', () => {
  const result = auditBuybackTransaction({ ...tx, condition: 'RUSAK 16K / 17K RP', pricePerGram: 1716000 }, window, [ref()]);
  assert.equal(result.status, 'Masih dalam batas range acuan'); assert.equal(result.minimum, 1716000); assert.equal(result.maximum, 1716000);
  assert.equal(auditBuybackTransaction({ ...tx, condition: 'RUSAK 16K / 17K' }, window, [ref()]).status, 'Di luar range acuan');
});
test('CUCI accepts only printed non-scrap cells and rejects incomplete or conflicting price categories', () => {
  const goodOnly = auditBuybackTransaction({ ...tx, pricePerGram: 1808000 }, window, [ref([rules[0]])]);
  assert.equal(goodOnly.minimum, 1808000); assert.equal(goodOnly.maximum, 1808000); assert.equal(goodOnly.status, 'Masih dalam batas range acuan');
  const stoneOnly = auditBuybackTransaction({ ...tx, pricePerGram: 1760000 }, window, [ref([rules[2]])]);
  assert.equal(stoneOnly.minimum, 1757000); assert.equal(stoneOnly.maximum, 1788000); assert.equal(stoneOnly.status, 'Masih dalam batas range acuan');
  for (const rows of [[rule('STONE', 1757000)], [rule('STONE', 1788000, 1757000)], [...rules, rule('GOOD', 1810000)]]) {
    assert.equal(auditBuybackTransaction(tx, window, [ref(rows)]).status, 'Perlu diperhatikan');
  }
});
test('missing master preserves observed price and never guesses a code from the amount', () => {
  const result = auditBuybackTransaction({ ...tx, internalCode: '-', pricePerGram: 1480000, lookupNote: 'Barang dengan barcode ini tidak ditemukan di tm_barang.' }, window, [ref()]);
  assert.equal(result.status, 'Perlu diperhatikan'); assert.equal(result.internalCode, '-'); assert.equal(result.minimum, null); assert.equal(result.maximum, null);
  assert.match(result.reason, /tidak ditemukan/); assert.match(result.reason, /1\.480\.000/);
});
test('ambiguous repeated code groups never combine boundaries or select a range by amount', () => {
  const variants = [
    { ...rule('GOOD', 1397000), sourceCode: 'C2', sourceRow: '700', printedKadar: '700' },
    { ...rule('STONE', 1356000, 1387000), sourceCode: 'C2', sourceRow: '700', printedKadar: '700' },
    { ...rule('GOOD', 1495000), sourceCode: 'C2', sourceRow: '750', printedKadar: '750' },
    { ...rule('STONE', 1459000, 1490000), sourceCode: 'C2', sourceRow: '750', printedKadar: '750' },
  ];
  const purchase = { ...tx, internalCode: 'C2 16', pricePerGram: 1492000 };
  assert.equal(auditBuybackTransaction(purchase, window, [ref(variants)]).status, 'Perlu diperhatikan');
  const resolved = auditBuybackTransaction({ ...purchase, printedKadar: '750' }, window, [ref(variants)]);
  assert.equal(resolved.minimum, 1459000); assert.equal(resolved.maximum, 1495000); assert.equal(resolved.status, 'Masih dalam batas range acuan');
});
test('missing cells, unknown code, unreadable condition, incomplete references and window boundaries need review', () => {
  for (const [purchase, references, selected] of [
    [tx, [ref([rule('STONE', 1757000)])], window],
    [tx, [ref(rules, false)], window], [{ ...tx, internalCode: 'Z9' }, [ref()], window],
    [{ ...tx, condition: '' }, [ref()], window], [{ ...tx, time: '' }, [ref()], undefined],
    [{ ...tx, time: '11:00:00' }, [ref()], window],
  ] as const) assert.equal(auditBuybackTransaction(purchase, selected, [...references]).status, 'Perlu diperhatikan');
});
test('young H04 keeps its printed tariff; RUSAK 8K and 9K require a known distinction', () => {
  const young: PriceRule[] = [
    { ...rule('GOOD', 773000), family: 'young', sourceCode: 'H04' },
    { ...rule('DAMAGED_8', 698000), family: 'young', sourceCode: '', sourceRow: '8' },
    { ...rule('DAMAGED_9', 719000), family: 'young', sourceCode: '', sourceRow: '9' },
  ];
  const purchase = { ...tx, internalCode: 'H04 8', condition: 'CUCI 8K / 9K', pricePerGram: 773000 };
  assert.equal(auditBuybackTransaction(purchase, window, [ref(young)]).status, 'Masih dalam batas range acuan');
  assert.equal(auditBuybackTransaction({ ...purchase, condition: 'RUSAK 8K / 9K' }, window, [ref(young)]).status, 'Perlu diperhatikan');
  for (const [printedKadar, pricePerGram] of [['8K', 698000], ['9K', 719000]] as const) {
    assert.equal(auditBuybackTransaction({ ...purchase, condition: 'RUSAK 8K / 9K', printedKadar, pricePerGram }, window, [ref(young)]).status, 'Masih dalam batas range acuan');
  }
});

// Prices transcribed from the four uploaded 23 November references.
const dailyDate = '2026-11-23';
const dayTx = (internalCode: string, pricePerGram: number): BuybackTransaction => ({ ...tx, date: dailyDate, internalCode, pricePerGram });
const oldBatch = (batch: number, stoneStart: number, stoneEnd: number, good: number): PriceReference => ({ ...ref(), id: `old-${batch}`, date: dailyDate, batch, filename: `TUA-${batch}.jpeg`, rows: [
  { ...rule('GOOD', good), sourceRow: 'D3' }, { ...rule('STONE', stoneStart, stoneEnd), sourceRow: 'D3' },
  { ...rule('SCRAP', batch === 1 ? 1754000 : 1766000), sourceRow: 'D3' },
] });
const youngBatch = (batch: number): PriceReference => ({ ...ref(), id: `young-${batch}`, date: dailyDate, batch, filename: `MUDA-${batch}.jpeg`, rows: [
  { ...rule('GOOD', batch === 1 ? 790000 : 795000), sourceCode: 'H04', family: 'young' },
  { ...rule('DAMAGED_8', batch === 1 ? 714000 : 719000), sourceCode: '', family: 'young', sourceRow: '8' },
  { ...rule('DAMAGED_9', batch === 1 ? 735000 : 740000), sourceCode: '', family: 'young', sourceRow: '9' },
] });
const daily = [youngBatch(2), oldBatch(1, 1796000, 1827000, 1848000), youngBatch(1), oldBatch(2, 1808000, 1840000, 1861000)];

test('D7 CUCI includes the full 1491–1533 / 1502–1544 references and reports the uploaded transaction in both batches', () => {
  const references = [oldBatch(1, 1491000, 1523000, 1533000), oldBatch(2, 1502000, 1533000, 1544000)].map(ref => ({ ...ref,
    rows: ref.rows.map(row => ({ ...row, sourceCode: 'D7', sourceRow: 'left:D7', rate: row.condition === 'SCRAP' ? ref.batch === 1 ? 1449000 : 1459000 : row.rate })),
  }));
  const result = auditBuybackBatches(dayTx('D7', 1507874), references);
  assert.deepEqual(result.batchEvaluations!.map(row => [row.minimum, row.maximum]), [[1491000, 1533000], [1502000, 1544000]]);
  assert.equal(result.priceStatus, 'Masih dalam batas range acuan');
  assert.equal(result.batch, 'Batch 1 / 2 — belum pasti');
  for (const [rate, batch] of [[1491000, 'Batch 1'], [1500000, 'Batch 1'], [1502000, 'Batch 1 / 2 — belum pasti'], [1533000, 'Batch 1 / 2 — belum pasti'], [1533001, 'Batch 2'], [1544000, 'Batch 2']] as const) {
    assert.equal(auditBuybackBatches(dayTx('D7', rate), references).batch, batch);
  }
  for (const rate of [1449000, 1459000, 1490999, 1544001]) assert.equal(auditBuybackBatches(dayTx('D7', rate), references).priceStatus, 'Di luar range acuan');
  for (const [rate, batch] of [[1449000, 'Batch 1'], [1459000, 'Batch 2']] as const) assert.equal(auditBuybackBatches({ ...dayTx('D7', rate), condition: 'RUSAK 16K / 17K' }, references).batch, batch);
  const table = buybackReportTable([result], references, true);
  const cell = (name: string) => table.rows[0][table.columns.indexOf(name)];
  assert.equal(cell('Range Batch 1 (IDR/gram)'), 'Rp1.491.000–Rp1.533.000');
  assert.equal(cell('Range Batch 2 (IDR/gram)'), 'Rp1.502.000–Rp1.544.000');
  assert.equal(cell('Batch yang Sesuai'), 'Batch 1 dan Batch 2');
  assert.match(String(cell('Keterangan Pemeriksaan')), /Harga masih dalam acuan Batch 1 dan Batch 2/);
  assert.doesNotMatch(String(cell('Keterangan Pemeriksaan')), /di bawah batas bawah/);
});

test('four buyback files immediately select whole-day mode without asking for hours', () => {
  const scope = priceAuditScope('tolong cek transaksi buyback dengan file ini', daily);
  assert.equal(scope.needsTime, false); assert.equal(scope.buybackAutoBatch, true);
  assert.equal(scope.selection?.buybackAutoBatch, true);
  assert.deepEqual(scope.selection?.windows, [{ date: dailyDate, fromTime: '00:00', toTime: '24:00', attachmentIds: daily.map(ref => ref.id) }]);
  assert.equal(priceAuditScope('cek buyback jam 9-11', daily).selection?.windows[0].fromTime, '00:00', 'buyback date mode does not depend on prompt hours');
  const conflict = priceAuditScope('cek tanggal 24/11/2026', daily); assert.equal(conflict.dateConflict, true); assert.equal(conflict.selection, undefined);
});
test('unique H04 rates identify Batch 1 and Batch 2 regardless of file order', () => {
  for (const [rate, batch] of [[790000, 1], [795000, 2]] as const) {
    const result = auditBuybackBatches(dayTx('H04 8', rate), daily);
    assert.equal(result.batch, `Batch ${batch}`); assert.equal(result.batchStatus, 'Satu batch sesuai');
    assert.equal(result.priceStatus, 'Masih dalam batas range acuan'); assert.equal(result.status, 'Masih dalam batas range acuan');
    assert.equal(result.minimum, rate); assert.equal(result.maximum, rate);
    assert.doesNotMatch(result.reference, /TUA/); assert.match(result.batchReason!, new RegExp(`Batch ${batch}`));
  }
});
test('separate batch checks never accept a price merely between two point tariffs', () => {
  const result = auditBuybackBatches(dayTx('H04', 792000), daily);
  assert.equal(result.status, 'Di luar range acuan'); assert.equal(result.batch, 'Tidak teridentifikasi');
  assert.equal(result.minimum, null); assert.equal(result.maximum, null); assert.equal(result.difference, null);
  assert.match(result.batchRanges!, /790\.000/); assert.match(result.batchRanges!, /795\.000/);
  assert.match(result.batchReason!, /Tidak dipilih batch terdekat/);
});
test('D3 unique prices use the selected batch bounds; overlap retains both without merging', () => {
  const unique = auditBuybackBatches(dayTx('D3', 1850000), daily);
  assert.equal(unique.batch, 'Batch 2'); assert.equal(unique.minimum, 1808000); assert.equal(unique.maximum, 1861000);
  assert.equal(auditBuybackBatches(dayTx('D3', 1800000), daily).batch, 'Batch 1');
  const overlap = auditBuybackBatches(dayTx('D3', 1845000), daily);
  assert.equal(overlap.batch, 'Batch 1 / 2 — belum pasti'); assert.equal(overlap.status, 'Perlu diperhatikan');
  assert.equal(overlap.priceStatus, 'Masih dalam batas range acuan'); assert.equal(overlap.batchStatus, 'Lebih dari satu batch sesuai');
  assert.equal(overlap.minimum, null); assert.equal(overlap.maximum, null);
  for (const amount of ['1.796.000', '1.848.000', '1.808.000', '1.861.000']) assert.ok(overlap.batchRanges!.includes(amount));
});
test('identical batch tariffs and touching inclusive boundaries are explicitly ambiguous', () => {
  const same = auditBuybackBatches(dayTx('H04', 790000), [youngBatch(1), { ...youngBatch(1), id: 'other', batch: 2 }]);
  assert.equal(same.batch, 'Batch 1 / 2 — belum pasti');
  const touch = auditBuybackBatches(dayTx('C5', 1533000), [oldBatch(1, 1523000, 1523000, 1533000), oldBatch(2, 1533000, 1533000, 1544000)].map(ref => ({ ...ref, rows: ref.rows.map(row => ({ ...row, sourceCode: 'C5' })) })));
  assert.equal(touch.batch, 'Batch 1 / 2 — belum pasti');
});
test('daily mode includes missing timestamps and excludes other document dates', () => {
  for (const time of ['', '00:00:00', '23:59:59']) assert.equal(auditBuybackBatches({ ...dayTx('H04', 795000), time }, daily).batch, 'Batch 2');
  const otherDate = { ...youngBatch(1), id: 'another-day', date: '2026-11-24', rows: youngBatch(2).rows };
  assert.equal(auditBuybackBatches(dayTx('H04', 795000), [...daily, otherDate]).batch, 'Batch 2');
});
test('missing batch metadata, unreadable references and missing masters cannot assert a unique batch', () => {
  const noHeader = auditBuybackBatches(dayTx('H04', 790000), [{ ...youngBatch(1), batch: null }]);
  assert.equal(noHeader.batch, 'Tidak diketahui'); assert.equal(noHeader.status, 'Perlu diperhatikan'); assert.equal(noHeader.priceStatus, 'Masih dalam batas range acuan');
  const partial = auditBuybackBatches(dayTx('H04', 790000), [youngBatch(1), { ...youngBatch(2), complete: false }]);
  assert.equal(partial.batch, 'Batch 1 — belum pasti'); assert.equal(partial.status, 'Perlu diperhatikan');
  const missing = auditBuybackBatches({ ...dayTx('-', 1480000), lookupNote: 'Barang tidak ditemukan di tm_barang.' }, daily);
  assert.equal(missing.batch, 'Tidak diketahui'); assert.match(missing.reason, /1\.480\.000/);
});
test('damaged young and old transactions are evaluated against their own batch tariffs', () => {
  const damaged = { ...dayTx('H04', 719000), condition: 'RUSAK 8K / 9K', printedKadar: '8K' };
  assert.equal(auditBuybackBatches(damaged, daily).batch, 'Batch 2');
  assert.equal(auditBuybackBatches({ ...dayTx('D3', 1754000), condition: 'RUSAK 16K / 17K' }, daily).batch, 'Batch 1');
});

test('daily comparisons retain numeric boundaries for every batch, including rejected and overlapping prices', () => {
  for (const purchase of [dayTx('H04', 792000), dayTx('D3', 1845000)]) {
    const result = auditBuybackBatches(purchase, daily);
    assert.equal(result.batchEvaluations?.length, 2);
    assert.ok(result.batchEvaluations!.every(item => item.minimum !== null && item.maximum !== null));
    assert.equal(result.minimum, null, 'the report does not invent one selected range');
  }
  const invalid = auditBuybackBatches({ ...dayTx('H04', 0), pricePerGram: null }, daily);
  assert.equal(invalid.status, 'Perlu diperhatikan');
  assert.deepEqual(invalid.batchEvaluations!.map(item => [item.minimum, item.maximum]), [[790000, 790000], [795000, 795000]], 'missing observed price does not discard known reference bounds');
});

test('buyback table shows one outcome, separate batch ranges and concise reasons without hiding rejected ranges', () => {
  const inputs = [dayTx('H04', 795000), dayTx('H04', 792000), dayTx('D3', 1845000), { ...dayTx('-', 1480000), lookupNote: 'Barang dengan barcode ini tidak ditemukan di tm_barang; kode internal tidak diketahui.' }];
  const table = buybackReportTable(inputs.map(purchase => auditBuybackBatches(purchase, daily)), daily, true);
  const cell = (i: number, name: string) => table.rows[i][table.columns.indexOf(name)];
  assert.equal(table.rows.length, 4);
  assert.ok(table.rows.every(row => row.length === table.columns.length));
  assert.ok(table.columns.indexOf('Range Batch 1 (IDR/gram)') < table.columns.indexOf('Range Batch 2 (IDR/gram)'));
  for (const oldColumn of ['Status Batch', 'Status Harga', 'Rincian Range per Batch', 'Batas Bawah Acuan per gram (IDR)']) assert.ok(!table.columns.includes(oldColumn));
  assert.equal(cell(0, 'Batch yang Sesuai'), 'Batch 2');
  assert.equal(cell(1, 'Hasil Pemeriksaan'), 'Di luar range acuan');
  assert.equal(cell(1, 'Range Batch 1 (IDR/gram)'), 'Rp790.000 (harga tunggal)');
  assert.equal(cell(1, 'Range Batch 2 (IDR/gram)'), 'Rp795.000 (harga tunggal)');
  assert.equal(cell(1, 'Batch yang Sesuai'), 'Tidak masuk batch mana pun');
  assert.equal(cell(1, 'Keterangan Pemeriksaan'), 'Harga buyback lebih tinggi Rp2.000 dari batas atas acuan Batch 1; Harga buyback lebih rendah Rp3.000 dari batas bawah acuan Batch 2.');
  assert.equal(cell(2, 'Batch yang Sesuai'), 'Batch 1 dan Batch 2');
  assert.equal(cell(2, 'Hasil Pemeriksaan'), 'Perlu diperhatikan');
  assert.equal(cell(2, 'Range Batch 1 (IDR/gram)'), 'Rp1.796.000–Rp1.848.000');
  assert.equal(cell(2, 'Range Batch 2 (IDR/gram)'), 'Rp1.808.000–Rp1.861.000');
  assert.match(String(cell(2, 'Keterangan Pemeriksaan')), /Harga masih dalam acuan Batch 1 dan Batch 2; batch tunggal belum dapat ditentukan/);
  assert.equal(cell(3, 'Kode Intern'), '-');
  assert.equal(cell(3, 'Harga Rata per gram (IDR)'), 1480000);
  assert.equal(cell(3, 'Range Batch 1 (IDR/gram)'), 'Kode intern belum diketahui');
  assert.match(String(cell(3, 'Keterangan Pemeriksaan')), /master barang.*Rp1\.480\.000/);
  assert.doesNotMatch(String(cell(3, 'Keterangan Pemeriksaan')), /tm_barang/);
  assert.ok(table.rows.every(row => !/\/gram|per\s+gram/i.test(String(row[table.columns.indexOf('Keterangan Pemeriksaan')]))));
});

test('missing headers, incomplete references and different document dates have explicit range labels', () => {
  const partialRefs = [youngBatch(1), { ...youngBatch(2), complete: false }];
  const partialTable = buybackReportTable([auditBuybackBatches(dayTx('H04', 790000), partialRefs)], partialRefs, true);
  const get = (name: string) => partialTable.rows[0][partialTable.columns.indexOf(name)];
  assert.equal(get('Range Batch 1 (IDR/gram)'), 'Rp790.000 (harga tunggal)');
  assert.equal(get('Range Batch 2 (IDR/gram)'), 'Pembacaan acuan belum lengkap');
  assert.equal(get('Batch yang Sesuai'), 'Batch 1 (belum pasti)');
  const unknownRefs = [{ ...youngBatch(1), batch: null }];
  const unknownTable = buybackReportTable([auditBuybackBatches(dayTx('H04', 790000), unknownRefs)], unknownRefs, true);
  assert.equal(unknownTable.rows[0][unknownTable.columns.indexOf('Range file tanpa nomor batch (IDR/gram)')], 'Rp790.000 (harga tunggal)');
  assert.equal(unknownTable.rows[0][unknownTable.columns.indexOf('Batch yang Sesuai')], 'Belum dapat ditentukan');
  const refs = [youngBatch(1), { ...youngBatch(2), date: '2026-11-24' }];
  const dateTable = buybackReportTable([auditBuybackBatches(dayTx('H04', 790000), refs)], refs, true);
  assert.equal(dateTable.rows[0][dateTable.columns.indexOf('Range Batch 2 (IDR/gram)')], 'File batch tidak tersedia untuk tanggal ini');
  const missingCode = buybackReportTable([auditBuybackBatches(dayTx('H1', 950555), daily)], daily, true);
  assert.equal(missingCode.rows[0][missingCode.columns.indexOf('Range Batch 1 (IDR/gram)')], 'Kode H1 tidak ada di file');
});
