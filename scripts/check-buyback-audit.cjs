// Offline fixtures: no production database, credentials, or model calls.
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
process.env.SYSTEM_DATABASE_NAME = 'buyback_fixture';
process.env.JWT_ACCESS_SECRET = 'offline-buyback-test-secret-at-least-32-characters';
process.env.ENC_KEY_DEC = 'price-fixture-key';
process.env.DEEPSEEK_API_KEY = 'offline-fixture-not-a-real-key';
const assert = require('node:assert/strict');
const { PriceAuditService, buybackAuditTransaction, priceAuditDetails, fillBuybackMaster } = require('../dist/src/agent/price-audit.service');
const { PriceReferenceService, PRICE_REFERENCE_PARSER_VERSION } = require('../dist/src/agent/price-reference.service');
const { priceAuditScope } = require('../dist/src/agent/price-audit-scope');
const { encryptBankField: enc } = require('../dist/src/agent/banking.logic');
const sources = [{ databaseName: 'pusat', alias: 'Italy Pusat', branchId: 'ITY' }, { databaseName: 'otista', alias: 'Italy Otista', branchId: 'IT2' }];
const rule = (condition, rate, maxRate = null) => ({ family: 'old', kind: 'buyback', kadar: null, sourceCode: 'D3', sourceRow: 'left:30', rate, maxRate, fee: null, feeType: 'unknown', condition, note: '' });
const references = [{ id: 'buyback', filename: 'buyback.png', date: '2026-11-20', complete: true, warnings: [], rows: [rule('GOOD', 1808000), rule('SCRAP', 1716000), rule('STONE', 1757000, 1788000)] }];
const dto = { windows: [{ date: '2026-11-20', fromTime: '09:00', toTime: '11:00', attachmentIds: ['buyback'] }], toleranceRp: 10000 };
const purchase = (id, barcode, rate, extra = {}) => ({ _id: id, no_faktur_beli: id, tgl_system: '2026-11-20', jam: enc('09:30:00'), nama_barang: enc('Cincin'), kode_barcode: barcode, kondisi: enc('CUCI 16K / 17K RP'), harga_rata: rate, harga: 9999999, berat: 2, status_valid: 'DONE', kode_intern: enc('WRONG'), ...extra });
const records = [
  purchase('within', '0011249980', 1800000, { berat: enc('1.71'), harga: 3490123.45, harga_nota: enc('3520456.75') }), purchase('outside', '0011249980', 1820000, { harga_nota: 0 }),
  purchase('lower', '0011249980', 1757000), purchase('upper', '0011249980', 1808000),
  purchase('scrap', '0011249980', 1716000, { kondisi: enc('RUSAK 16K / 17K RP') }),
  purchase('old-missing', '0099999999', 1480000), purchase('no-rate', '0011249980', undefined),
  purchase('cancelled', '0011249980', 1800000, { status_valid: 'CANC' }),
  purchase('boundary', '0011249980', 1800000, { jam: enc('11:00:00') }),
  { ...purchase('group', 'parent-must-not-leak', 9999999), detail_barang: [purchase('leaf', '0011249980', 1800000), purchase('cancelled-leaf', '0011249980', 1800000, { status_valid: 'CANC' })] },
];
let masterQueries = 0;
const readCollections = new Set();
const mongo = { getDatabase(database) { return {
  listCollections() { return { async hasNext() { return true; } }; },
  collection(name) {
    readCollections.add(name);
    if (name === 'tm_barang') return { find(query, { projection }) {
      masterQueries++; assert.equal(projection.kode_intern, 1); assert.equal(projection.kode_barcode, 1);
      assert.deepEqual(query.kode_barcode.$in.sort(), ['0011249980', '0099999999']);
      return { maxTimeMS(ms) { assert.equal(ms, 5000); return this; }, limit() { return this; }, async toArray() { return [{ kode_barcode: '0011249980', kode_intern: enc(database === 'pusat' ? 'D3 16' : 'D3 17'), kadar_cetak: enc('750') }]; } };
    } };
    assert.equal(name, 'tt_beli_detail', 'buyback-only uploads must not scan sales');
    return { find(query, { projection }) {
      assert.equal(query.status_valid.$ne, 'CANC'); assert.equal(projection.harga_rata, 1); assert.equal(projection.kondisi, 1); assert.equal(projection['detail_barang.harga_rata'], 1);
      assert.equal(projection.harga, 1); assert.equal(projection.harga_nota, 1); assert.equal(projection['detail_barang.harga_nota'], 1);
      return { maxTimeMS() { return this; }, batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* records; } };
    } };
  },
}; } };

(async () => {
  const normalized = buybackAuditTransaction(records[0], 'Italy');
  assert.equal(normalized.condition, 'CUCI 16K / 17K RP'); assert.equal(normalized.pricePerGram, 1800000); assert.equal(normalized.internalCode, '-');
  assert.equal(normalized.weight, 1.71); assert.equal(normalized.price, 3490123.45); assert.equal(normalized.invoicePrice, 3520456.75);
  const noteDetails = priceAuditDetails({ _id: 'parent', harga_nota: 9999999, detail_barang: [{ harga_nota: enc('12345.67') }, {}] }, 'buyback');
  assert.deepEqual(noteDetails.map(row => buybackAuditTransaction(row, 'Italy').invoicePrice), [12345.67, null], 'invoice totals must not leak from a grouped header into unrelated detail rows');
  assert.equal(priceAuditDetails(records[7], 'buyback').length, 0);
  const report = await new PriceAuditService(mongo, { async read() { return structuredClone(references); } }).report(dto, sources, 'owner', 'session');
  const table = report.blocks.find(block => block.type === 'table' && block.title === 'Audit harga buyback perhiasan');
  const cell = (row, name) => row[table.columns.indexOf(name)];
  const conditionIndex = table.columns.indexOf('Kondisi');
  assert.deepEqual(table.columns.slice(conditionIndex, conditionIndex + 5), ['Kondisi', 'Berat (gram)', 'Harga Buyback (IDR)', 'Harga Nota (IDR)', 'Harga Rata per gram (IDR)']);
  assert.equal(table.columns.filter(column => column === 'Berat (gram)').length, 1);
  assert.ok(table.rows.every(row => row.length === table.columns.length));
  assert.equal(table.rows.length, 16, 'eight non-cancelled in-window details from each store, including missing master and rate');
  assert.equal(masterQueries, 2, 'one batch master lookup per store; repeated barcodes share the cache');
  assert.deepEqual([...readCollections].sort(), ['tm_barang', 'tt_beli_detail']);
  assert.ok(!report.blocks.some(block => block.type === 'table' && /penjualan/.test(block.title)));
  for (const source of sources) {
    const rows = table.rows.filter(row => cell(row, 'Toko') === source.alias);
    const within = rows.find(row => cell(row, 'No. Faktur') === 'within');
    assert.equal(cell(within, 'Kode Intern'), source.databaseName === 'pusat' ? 'D3 16' : 'D3 17');
    assert.equal(cell(within, 'Kode Acuan'), 'D3'); assert.equal(cell(within, 'Kondisi'), 'CUCI 16K / 17K RP');
    assert.equal(cell(within, 'Berat (gram)'), 1.71); assert.equal(cell(within, 'Harga Buyback (IDR)'), 3490123.45); assert.equal(cell(within, 'Harga Nota (IDR)'), 3520456.75);
    assert.equal(cell(within, 'Harga Rata per gram (IDR)'), 1800000); assert.equal(cell(within, 'Range acuan (IDR/gram)'), 'Rp1.757.000–Rp1.808.000');
    assert.equal(cell(within, 'Hasil Pemeriksaan'), 'Masih dalam batas range acuan');
    const outside = rows.find(row => cell(row, 'No. Faktur') === 'outside');
    assert.equal(cell(outside, 'Harga Nota (IDR)'), 0);
    assert.equal(cell(outside, 'Hasil Pemeriksaan'), 'Di luar range acuan', 'sales tolerance does not widen the buyback range');
    assert.match(cell(outside, 'Keterangan Pemeriksaan'), /12\.000/);
    assert.equal(cell(outside, 'Range acuan (IDR/gram)'), 'Rp1.757.000–Rp1.808.000');
    const missing = rows.find(row => cell(row, 'No. Faktur') === 'old-missing');
    assert.equal(cell(missing, 'Kode Intern'), '-'); assert.equal(cell(missing, 'Harga Rata per gram (IDR)'), 1480000);
    assert.equal(cell(missing, 'Hasil Pemeriksaan'), 'Perlu diperhatikan'); assert.match(cell(missing, 'Keterangan Pemeriksaan'), /1\.480\.000/);
    assert.equal(cell(missing, 'Range acuan (IDR/gram)'), 'Kode intern belum diketahui');
    assert.ok(!rows.some(row => /cancelled|boundary/.test(cell(row, 'No. Faktur'))));
  }
  const brokenMaster = { collection() { return { find() { throw new Error('fixture database unavailable'); } }; } };
  const unlinked = { record: records[0], tx: buybackAuditTransaction(records[0], 'Italy') };
  await fillBuybackMaster([unlinked], brokenMaster, new Map()); assert.equal(unlinked.tx.internalCode, '-'); assert.match(unlinked.tx.lookupNote, /belum dapat dibaca/);

  const dailyDate = '2026-11-23';
  const dayRefs = [1, 2].flatMap(batch => [
    { ...references[0], id: `young-${batch}`, filename: `muda-${batch}.jpeg`, date: dailyDate, batch, rows: [{ ...rule('GOOD', batch === 1 ? 790000 : 795000), family: 'young', sourceCode: 'H04' }] },
    { ...references[0], id: `old-${batch}`, filename: `tua-${batch}.jpeg`, date: dailyDate, batch, rows: [rule('GOOD', batch === 1 ? 1848000 : 1861000), rule('STONE', batch === 1 ? 1796000 : 1808000, batch === 1 ? 1827000 : 1840000)] },
  ]);
  const scope = priceAuditScope('tolong cek transaksi buyback dengan empat file ini', dayRefs);
  assert.equal(scope.needsTime, false); assert.equal(scope.selection.buybackAutoBatch, true);
  assert.equal(scope.selection.windows.length, 1); assert.equal(scope.selection.windows[0].attachmentIds.length, 4);
  const dayPurchase = (id, barcode, rate, time = '09:00:00', extra = {}) => purchase(id, barcode, rate, { tgl_system: dailyDate, jam: time ? enc(time) : '', ...extra });
  const dayRecords = [
    dayPurchase('b1', 'young', 790000, '00:00:01'), dayPurchase('b2', 'young', 795000, '23:59:59'),
    dayPurchase('gap', 'young', 792000), dayPurchase('overlap', 'old', 1845000), dayPurchase('unique-old', 'old', 1850000),
    dayPurchase('missing-day', 'missing', 1480000, ''), dayPurchase('no-time', 'young', 795000, ''),
    dayPurchase('cancelled-day', 'young', 790000, '09:00:00', { status_valid: 'CANC' }),
    dayPurchase('wrong-date', 'young', 795000, '09:00:00', { tgl_system: '2026-11-24' }),
  ];
  let dailyLookups = 0;
  const dailyMongo = { getDatabase(database) { return {
    listCollections() { return { async hasNext() { return true; } }; },
    collection(name) {
      if (name === 'tm_barang') return { find(query) {
        dailyLookups++; assert.deepEqual(query.kode_barcode.$in.sort(), ['missing', 'old', 'young']);
        return { maxTimeMS() { return this; }, limit() { return this; }, async toArray() { return [{ kode_barcode: 'young', kode_intern: enc('H04 8') }, { kode_barcode: 'old', kode_intern: enc(database === 'pusat' ? 'D3 16' : 'D3 17') }]; } };
      } };
      assert.equal(name, 'tt_beli_detail');
      return { find(query) { assert.equal(query.status_valid.$ne, 'CANC'); return { maxTimeMS() { return this; }, batchSize() { return this; }, async close() {}, async *[Symbol.asyncIterator]() { yield* dayRecords; } }; } };
    },
  }; } };
  const dailyReport = await new PriceAuditService(dailyMongo, { async read() { return structuredClone(dayRefs); } }).report(scope.selection, sources, 'owner', 'session');
  const dailyTable = dailyReport.blocks.find(block => block.type === 'table' && block.title === 'Audit harga buyback perhiasan');
  const dayCell = (row, column) => row[dailyTable.columns.indexOf(column)];
  assert.equal(dailyTable.rows.length, 14, 'each transaction appears once per store, never once per batch'); assert.equal(dailyLookups, 2);
  for (const source of sources) {
    const rows = dailyTable.rows.filter(row => dayCell(row, 'Toko') === source.alias);
    const byInvoice = invoice => rows.find(row => dayCell(row, 'No. Faktur') === invoice);
    assert.equal(dayCell(byInvoice('b1'), 'Batch yang Sesuai'), 'Batch 1'); assert.equal(dayCell(byInvoice('b2'), 'Batch yang Sesuai'), 'Batch 2');
    assert.equal(dayCell(byInvoice('no-time'), 'Batch yang Sesuai'), 'Batch 2', 'missing timestamp does not block whole-day checks');
    assert.equal(dayCell(byInvoice('gap'), 'Batch yang Sesuai'), 'Tidak masuk batch mana pun'); assert.equal(dayCell(byInvoice('gap'), 'Hasil Pemeriksaan'), 'Di luar range acuan');
    assert.equal(dayCell(byInvoice('gap'), 'Range Batch 1 (IDR/gram)'), 'Rp790.000 (harga tunggal)');
    assert.equal(dayCell(byInvoice('gap'), 'Range Batch 2 (IDR/gram)'), 'Rp795.000 (harga tunggal)');
    const overlap = byInvoice('overlap'); assert.equal(dayCell(overlap, 'Batch yang Sesuai'), 'Batch 1 dan Batch 2');
    assert.equal(dayCell(overlap, 'Hasil Pemeriksaan'), 'Perlu diperhatikan');
    assert.equal(dayCell(overlap, 'Range Batch 1 (IDR/gram)'), 'Rp1.796.000–Rp1.848.000');
    assert.equal(dayCell(overlap, 'Range Batch 2 (IDR/gram)'), 'Rp1.808.000–Rp1.861.000');
    assert.match(dayCell(overlap, 'Keterangan Pemeriksaan'), /Harga masih dalam acuan Batch 1 dan Batch 2/);
    assert.equal(dayCell(byInvoice('unique-old'), 'Batch yang Sesuai'), 'Batch 2'); assert.equal(dayCell(byInvoice('unique-old'), 'Range Batch 2 (IDR/gram)'), 'Rp1.808.000–Rp1.861.000');
    assert.equal(dayCell(byInvoice('missing-day'), 'Kode Intern'), '-'); assert.equal(dayCell(byInvoice('missing-day'), 'Batch yang Sesuai'), 'Belum dapat ditentukan');
    assert.ok(!rows.some(row => /cancelled|wrong-date/.test(dayCell(row, 'No. Faktur'))));
  }
  const refTable = dailyReport.blocks.find(block => block.type === 'table' && block.title === 'Daftar acuan pemeriksaan harga');
  assert.equal(refTable.rows.length, 4); assert.ok(refTable.columns.includes('Batch')); assert.ok(!refTable.columns.some(column => /jam/i.test(column)));

  const originalFetch = global.fetch;
  const modelReply = require('./price-cell-fixture.cjs').withPriceCellVerification;
  let saved;
  const parser = new PriceReferenceService(require('./price-cache-fixture.cjs').withPriceCache({ db: { collection() { return { async updateOne(query, update) { saved = update.$set; } }; } } }), {
    async uploadPriceAttachment(_session, _owner, _buffer, filename) { return { id: '000000000000000000000001', filename, mime: 'image/png' }; }, async deleteAttachment() {},
  }, { async resolveActorEmail() { return ''; }, async begin() { return 'fixture'; }, async finish() {} });
  const compact = (sourceCode, extra = {}) => ({ family: 'old', sourceCode, sourceLabel: '', printedKadar: '', goodThousands: 1808, scrapThousands: 1716, stoneMinThousands: 1757, stoneMaxThousands: 1788, ...extra });
  try {
    global.fetch = modelReply(async (_, options) => {
      const payload = JSON.parse(options.body); assert.match(payload.messages[0].content, /ONE compact row per physical code row/); assert.match(payload.messages[0].content, /batch ONLY from a printed document HEADER/); assert.match(payload.messages[0].content, /SAME merged price cell/); assert.doesNotMatch(payload.messages[0].content, /READING IS PAUSED/);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ isJewelryPrice: true, date: '2026-11-20', batch: 2, complete: true, warnings: [], rows: [], buybackRows: [
        compact('D3'), compact('D1/E1'), compact('C4', { goodThousands: 1539, scrapThousands: 1459, stoneMinThousands: 1502, stoneMaxThousands: 1533 }),
        compact('H04', { family: 'young', goodThousands: 773, scrapThousands: null, stoneMinThousands: null, stoneMaxThousands: null }),
        compact('', { family: 'young', goodThousands: null, scrapThousands: null, stoneMinThousands: null, stoneMaxThousands: null, damaged8Thousands: 698 }),
        compact('', { family: 'young', goodThousands: null, scrapThousands: null, stoneMinThousands: null, stoneMaxThousands: null, damaged9Thousands: 719 }),
      ] }) } }] }), { status: 200 });
    });
    const parsed = await parser.upload('000000000000000000000002', 'owner', Buffer.from('fixture'), 'misleading-BATCH-1.png');
    assert.equal(parsed.rows.length, 15); assert.equal(saved.parserVersion, PRICE_REFERENCE_PARSER_VERSION);
    assert.equal(parsed.batch, 2, 'batch is copied from the document header, never the misleading filename'); assert.equal(saved.batch, 2);
    const d3 = parsed.rows.filter(row => row.sourceCode === 'D3');
    assert.deepEqual(d3.map(row => [row.condition, row.rate, row.maxRate]), [['GOOD', 1808000, null], ['SCRAP', 1716000, null], ['STONE', 1757000, 1788000]]);
    assert.equal(new Set(d3.map(row => row.sourceRow)).size, 1);
    assert.deepEqual(parsed.rows.filter(row => row.sourceCode === 'C4').map(row => [row.condition, row.rate, row.maxRate]), [['GOOD', 1539000, null], ['SCRAP', 1459000, null], ['STONE', 1502000, 1533000]], 'blue merged-cell bounds stay attached to their physical row');
    assert.equal(parsed.rows.filter(row => row.sourceCode === 'D1').length, 3); assert.equal(parsed.rows.filter(row => row.sourceCode === 'E1').length, 3);
    assert.equal(parsed.rows.find(row => row.sourceCode === 'H04').rate, 773000);
    assert.equal(parsed.rows.find(row => row.condition === 'DAMAGED_8').rate, 698000); assert.equal(parsed.rows.find(row => row.condition === 'DAMAGED_9').rate, 719000);
  } finally { global.fetch = originalFetch; }
  console.log('Buyback passed: decrypted master codes/conditions, direct harga_rata, D3 bounds, CANC exclusion, missing masters, four-file daily batches, unique/overlapping/gap prices, per-store batching and header batch extraction.');
})().catch(error => { console.error(error); process.exitCode = 1; });
